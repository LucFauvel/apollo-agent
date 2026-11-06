import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApollo } from "../AppState.tsx";
import type { Pairing } from "../connection.ts";
import { errorMessage } from "../connection.ts";
import { currentPushStatus, type PushStatus, registerForPush, sendTestNotification, subscribePushStatus } from "../push.ts";
import { colors } from "../theme.ts";

/** This phone's connection to Apollo, its notifications, and unpairing. */
export function SettingsScreen({ pairing, onBack, onUnpair }: { pairing: Pairing; onBack: () => void; onUnpair: () => void }) {
  const { state } = useApollo();
  const [push, setPush] = useState<PushStatus>(currentPushStatus);
  useEffect(() => subscribePushStatus(setPush), []);
  const [test, setTest] = useState<string | null>(null);

  const host = (() => {
    try {
      return new URL(pairing.server).host;
    } catch {
      return pairing.server;
    }
  })();

  const pushText =
    push.state === "on"
      ? "On. You'll get one when a turn finishes, or a bot needs an approval, an answer or a secret."
      : push.state === "checking"
        ? "Turning on…"
        : push.state === "denied"
          ? "Off. Allow notifications for Apollo in the iPhone's Settings."
          : `Couldn't turn on: ${push.message}`;
  const pushColor = push.state === "on" ? colors.green : push.state === "checking" ? colors.muted : push.state === "denied" ? colors.amber : colors.red;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.section}>Connection</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: state.connected ? colors.green : colors.amber }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{state.connected ? "Connected" : "Connecting…"}</Text>
              <Text style={styles.rowDetail} numberOfLines={1}>
                {host} · over Tailscale
              </Text>
            </View>
          </View>
        </View>

        <Text style={styles.section}>Notifications</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: pushColor }]} />
            <Text style={[styles.rowDetail, { flex: 1 }]}>{pushText}</Text>
          </View>
          <View style={styles.divider} />
          {push.state === "on" ? (
            <Pressable
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
              onPress={() => {
                setTest("Sending…");
                sendTestNotification(pairing)
                  .then(() => setTest("Sent. It should arrive in a few seconds."))
                  .catch((e) => setTest(`Couldn't send: ${errorMessage(e)}`));
              }}
            >
              <Text style={styles.actionText}>Send a test notification</Text>
            </Pressable>
          ) : push.state === "denied" ? (
            <Pressable style={({ pressed }) => [styles.action, pressed && styles.pressed]} onPress={() => void Linking.openSettings()}>
              <Text style={styles.actionText}>Open Settings</Text>
            </Pressable>
          ) : (
            <Pressable style={({ pressed }) => [styles.action, pressed && styles.pressed]} onPress={() => void registerForPush(pairing)}>
              <Text style={styles.actionText}>Try again</Text>
            </Pressable>
          )}
        </View>
        {test ? <Text style={styles.hint}>{test}</Text> : null}

        <Text style={styles.section}>This phone</Text>
        <View style={styles.card}>
          <Pressable
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            onPress={() =>
              Alert.alert("Unpair this phone?", "You'll need to scan a new code from Apollo on your computer to use it again.", [
                { text: "Cancel", style: "cancel" },
                { text: "Unpair", style: "destructive", onPress: onUnpair },
              ])
            }
          >
            <Text style={[styles.actionText, { color: colors.red }]}>Unpair</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 12 },
  back: { color: colors.accent, fontSize: 16 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  body: { padding: 16, gap: 8 },
  section: { color: colors.faint, fontSize: 11, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase", marginTop: 14, marginLeft: 4 },
  card: { backgroundColor: colors.panelSoft, borderRadius: 14, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "500" },
  rowDetail: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  divider: { height: 1, backgroundColor: colors.border },
  action: { paddingHorizontal: 14, paddingVertical: 13 },
  actionText: { color: colors.accent, fontSize: 15 },
  pressed: { opacity: 0.55 },
  hint: { color: colors.muted, fontSize: 12, marginLeft: 4 },
});
