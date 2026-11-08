import type { SessionId } from "@apollo/contracts";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AppStateProvider, useApollo } from "./src/AppState.tsx";
import { useAvatarImages } from "./src/avatars.ts";
import {
  connect,
  forgetPairing,
  loadPairing,
  type Pairing,
  parsePairingCode,
  prepareRoute,
  type Route,
} from "./src/connection.ts";
import { ChatScreen } from "./src/screens/ChatScreen.tsx";
import { HomeScreen } from "./src/screens/HomeScreen.tsx";
import { PairScreen } from "./src/screens/PairScreen.tsx";
import { SettingsScreen } from "./src/screens/SettingsScreen.tsx";
import { SlideIn, SwipeBack } from "./src/motion.tsx";
import { registerForPush, sessionOf, setViewingSession, unregisterPush } from "./src/push.ts";
import { colors } from "./src/theme.ts";

export default function App() {
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [open, setOpen] = useState<SessionId | null>(null);
  const [settings, setSettings] = useState(false);
  // Scanning the QR code with the phone's own camera app opens apollo://pair?… here.
  const link = Linking.useURL();
  // A link handled once (paired, or failed) must not reopen the pairing screen.
  const [usedLink, setUsedLink] = useState<string | null>(null);
  const linkCode =
    link && link !== usedLink && parsePairingCode(link) ? link : null;

  useEffect(() => {
    void loadPairing().then(setPairing);
  }, []);

  // Notifications: register once paired; tapping one opens its conversation.
  useEffect(() => {
    if (pairing) void registerForPush(pairing);
  }, [pairing]);
  const tapped = Notifications.useLastNotificationResponse();
  useEffect(() => {
    const sessionId = sessionOf(tapped);
    if (sessionId) setOpen(sessionId);
  }, [tapped]);
  useEffect(() => setViewingSession(open), [open]);

  // iOS kills sockets while the app is in the background. Coming back opens a fresh
  // connection right away rather than waiting for the old one to time out.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let backgroundedAt: number | null = null;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background") backgroundedAt = Date.now();
      else if (next === "active" && backgroundedAt !== null) {
        if (Date.now() - backgroundedAt > 3000) setGeneration((g) => g + 1);
        backgroundedAt = null;
      }
    });
    return () => sub.remove();
  }, []);

  // The route (the app's own tailnet relay) and a first signed proof take a moment.
  const [route, setRoute] = useState<{ readonly pairing: Pairing; readonly route: Route } | null>(null);
  useEffect(() => {
    if (!pairing) return setRoute(null);
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    prepareRoute(pairing).then(
      (next) => {
        if (cancelled) next.proofs.dispose();
        else setRoute({ pairing, route: next });
      },
      // The app's Tailscale node is still starting (or briefly offline): try again shortly.
      () => {
        if (!cancelled) retry = setTimeout(() => setGeneration((g) => g + 1), 2000);
      },
    );
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [pairing, generation]);
  const connection = useMemo(
    () => (pairing && route?.pairing === pairing ? connect(pairing, route.route) : null),
    [pairing, route],
  );
  useEffect(() => () => void connection?.dispose(), [connection]);

  const unpair = () => {
    void (pairing ? unregisterPush(pairing) : Promise.resolve()).then(forgetPairing).then(() => {
      setOpen(null);
      setPairing(null);
    });
  };

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        {pairing === undefined || (pairing && !connection && !linkCode) ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.muted} />
          </View>
        ) : !pairing || !connection || (linkCode && !open) ? (
          <PairScreen
            initialCode={linkCode}
            onPaired={(next) => {
              setUsedLink(link);
              setPairing(next);
            }}
          />
        ) : (
          <AppStateProvider connection={connection}>
            <AvatarSync pairing={pairing} />
            {open ? (
              <SwipeBack key={open} onBack={() => setOpen(null)}>
                <ChatScreen sessionId={open} onBack={() => setOpen(null)} />
              </SwipeBack>
            ) : settings ? (
              <SwipeBack key="settings" onBack={() => setSettings(false)}>
                <SettingsScreen
                  pairing={pairing}
                  onBack={() => setSettings(false)}
                  onUnpair={() => {
                    setSettings(false);
                    unpair();
                  }}
                />
              </SwipeBack>
            ) : (
              <SlideIn key="home" from="left">
                <HomeScreen onOpen={setOpen} onSettings={() => setSettings(true)} />
              </SlideIn>
            )}
          </AppStateProvider>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});

/** Keeps the bots' avatar images on this phone, for notifications. */
function AvatarSync({ pairing }: { pairing: Pairing }) {
  const { state } = useApollo();
  useAvatarImages(pairing, state.bots, state.connected);
  return null;
}
