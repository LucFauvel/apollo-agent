import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { errorMessage, type Pairing, pair, parsePairingCode } from "../connection.ts";
import { startTailnet, tailnetAvailable, type TailnetStatus, tailnetStatus } from "../tailnet.ts";
import { colors } from "../theme.ts";

/**
 * First run: scan the QR code from Apollo on the computer (Devices → Pair a phone), or
 * paste its code. The one-time token becomes a session token kept in secure storage.
 */
export function PairScreen({ onPaired, initialCode }: { onPaired: (pairing: Pairing) => void; initialCode?: string | null }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState(initialCode ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each pairing token works once. The camera reports the same code many times a second, so
  // every token is tried at most once and scanning stops while a request is in flight.
  const tried = useRef(new Set<string>());
  const inFlight = useRef(false);

  // The app's own Tailscale node: sign in once, in the browser, with the same account as the computer.
  const [tailnet, setTailnet] = useState<TailnetStatus | null>(null);
  const [tailnetError, setTailnetError] = useState<string | null>(null);
  useEffect(() => {
    if (!tailnetAvailable) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (first: boolean) =>
      (first ? startTailnet() : tailnetStatus())
        .then((status) => {
          if (stopped) return;
          setTailnet(status);
          setTailnetError(null);
          if (status?.state !== "Running") timer = setTimeout(() => void poll(false), 2000);
        })
        .catch((e) => {
          if (stopped) return;
          setTailnetError(errorMessage(e));
          timer = setTimeout(() => void poll(true), 5000);
        });
    void poll(true);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  const tailnetReady = !tailnetAvailable || tailnet?.state === "Running";

  const tryCode = (text: string) => {
    const code = parsePairingCode(text);
    if (!code) {
      setError("That is not an Apollo pairing code.");
      return;
    }
    if (inFlight.current) return;
    if (code.pin && !tailnetReady) {
      setError("Sign in to Tailscale above first, then scan the code again.");
      return;
    }
    if (tried.current.has(code.token)) {
      setError("This code was already used. Show a new code on the computer (Devices → Pair a phone).");
      return;
    }
    tried.current.add(code.token);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    pair(code)
      .then(onPaired)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  // Opened through a pairing link (the QR code scanned with the phone's Camera app): pair right away.
  useEffect(() => {
    if (initialCode && parsePairingCode(initialCode)) tryCode(initialCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Pair with Apollo</Text>
      <Text style={styles.subtitle}>
        On your computer, open Apollo → Devices → Pair a phone, scan the code, then allow this phone on the computer.
      </Text>

      {tailnetAvailable ? (
        <View style={styles.tailnetCard}>
          <View style={[styles.dot, { backgroundColor: tailnet?.state === "Running" ? colors.green : colors.amber }]} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.tailnetTitle}>
              {tailnet?.state === "Running" ? "Tailscale is connected" : "Sign in to Tailscale"}
            </Text>
            <Text style={styles.tailnetDetail}>
              {tailnet?.state === "Running"
                ? `${tailnet.loginName ?? "Signed in"} · ${tailnet.dnsName ?? "this iPhone"}`
                : tailnetError ??
                  "Apollo has its own Tailscale connection, so the Tailscale app is not needed. Use the same account as on your computer."}
            </Text>
          </View>
          {tailnet?.state !== "Running" && tailnet?.authUrl ? (
            <Pressable style={[styles.button, styles.small]} onPress={() => void Linking.openURL(tailnet.authUrl!)}>
              <Text style={styles.buttonText}>Sign in</Text>
            </Pressable>
          ) : tailnet?.state !== "Running" ? (
            <ActivityIndicator color={colors.muted} />
          ) : null}
        </View>
      ) : null}

      <View style={styles.cameraBox}>
        {!permission ? null : permission.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            // No handler while pairing: the camera stops reporting codes.
            onBarcodeScanned={
              busy
                ? undefined
                : ({ data }) => {
                    const code = parsePairingCode(data);
                    // Ignore other QR codes and ones already tried (the camera repeats them).
                    if (code && !tried.current.has(code.token)) tryCode(data);
                  }
            }
          />
        ) : (
          <Pressable style={styles.button} onPress={() => void requestPermission()}>
            <Text style={styles.buttonText}>Allow camera to scan</Text>
          </Pressable>
        )}
        {busy ? (
          <View style={styles.overlay}>
            <ActivityIndicator color={colors.text} />
            <Text style={styles.overlayText}>Allow this phone on your computer…</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.label}>Or paste the pairing code</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={manual}
          onChangeText={setManual}
          placeholder="apollo://pair?server=…"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable style={[styles.button, styles.small]} onPress={() => tryCode(manual)} disabled={busy || !manual.trim()}>
          <Text style={styles.buttonText}>Pair</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 20, gap: 14, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 26, fontWeight: "700", marginTop: 12 },
  subtitle: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  cameraBox: {
    aspectRatio: 1,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", gap: 8 },
  overlayText: { color: colors.text },
  label: { color: colors.muted, fontSize: 12, marginTop: 6 },
  row: { flexDirection: "row", gap: 8 },
  input: {
    flex: 1,
    color: colors.text,
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
  },
  button: { backgroundColor: colors.text, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 11, alignItems: "center" },
  small: { justifyContent: "center" },
  tailnetCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 16,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tailnetTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  tailnetDetail: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  buttonText: { color: colors.bg, fontWeight: "600" },
  error: { color: colors.red, fontSize: 13 },
});
