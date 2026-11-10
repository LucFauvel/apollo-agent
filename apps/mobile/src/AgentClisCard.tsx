import type { AccountProvider, AgentCliState } from "@apollo/contracts";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useApollo } from "./AppState.tsx";
import { errorMessage } from "./connection.ts";
import { colors } from "./theme.ts";

const NAMES: Record<AccountProvider, { name: string; site: string }> = {
  claude: { name: "Claude Code", site: "Claude" },
  codex: { name: "Codex", site: "ChatGPT" },
};

const PLANS: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", plus: "Plus", business: "Business", free: "Free" };

const loginText = (cli: AgentCliState) => {
  const login = cli.login;
  if (cli.signIn) return "Signing in…";
  if (!login) return "Checking the login…";
  if (!login.loggedIn) return "Not signed in";
  return ["Signed in", login.email, login.orgName, login.plan ? (PLANS[login.plan] ?? login.plan) : null].filter(Boolean).join(" · ");
};

/**
 * Claude Code and Codex on the paired computer: install them there and sign its login in
 * from the phone (Codex with a one-time code, Claude with the code its page shows).
 */
export function AgentClisCard() {
  const { connection, state } = useApollo();
  const [clis, setClis] = useState<ReadonlyArray<AgentCliState> | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const connected = useRef(state.connected);
  connected.current = state.connected;
  useEffect(() => {
    let received = false;
    let stop: (() => void) | null = null;
    stop = connection.follow(
      (client) => client["agentClis.watch"](),
      (next) => {
        received = true;
        setClis(next);
      },
      () => {
        // Connected, yet the stream fails at once: an older Apollo that does not know it.
        if (!received && connected.current) {
          setUnsupported(true);
          stop?.();
        }
      },
    );
    return () => stop?.();
  }, [connection]);

  if (unsupported) return <Text style={styles.hint}>Update Apollo on the computer to install and sign in to Claude Code and Codex from here.</Text>;
  if (!clis) {
    return (
      <View style={styles.card}>
        <View style={styles.row}>
          <ActivityIndicator color={colors.muted} />
        </View>
      </View>
    );
  }
  return (
    <View style={styles.card}>
      {clis.map((cli, i) => (
        <View key={cli.provider}>
          {i > 0 ? <View style={styles.divider} /> : null}
          <CliRow cli={cli} />
        </View>
      ))}
    </View>
  );
}

function CliRow({ cli }: { cli: AgentCliState }) {
  const { connection } = useApollo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const { provider } = cli;
  const { name, site } = NAMES[provider];
  const run = (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    f()
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const install = () =>
    Alert.alert(`Install ${name}?`, `Apollo runs ${name}'s official installer on the computer. It takes a minute or two.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Install", onPress: () => run(() => connection.rpc((c) => c["agentClis.install"]({ provider }))) },
    ]);
  const signIn = () => run(() => connection.rpc((c) => c["agentClis.signIn"]({ provider, device: true })));

  let detail: string;
  let action: { label: string; onPress: () => void } | null = null;
  if (cli.install) {
    detail = `Installing: ${cli.install.step}`;
  } else if (!cli.executable) {
    detail = cli.bundled ? "Comes with Apollo on the computer" : "Not installed on the computer";
    if (!cli.bundled) action = { label: `Install ${name}`, onPress: install };
  } else {
    detail = loginText(cli);
    if (!cli.signIn && cli.login) action = { label: cli.login.loggedIn ? "Sign in to another account" : "Sign in", onPress: signIn };
  }
  const shownError = error ?? (cli.install ? null : cli.installError ? `Install failed: ${cli.installError}` : null) ?? cli.signIn?.error ?? null;

  return (
    <View>
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: cli.install ? colors.accent : cli.login?.loggedIn ? colors.green : cli.executable ? colors.amber : colors.faint }]} />
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>{name}</Text>
          <Text style={styles.rowDetail} numberOfLines={3}>
            {detail}
          </Text>
        </View>
        {cli.install || busy ? <ActivityIndicator color={colors.muted} /> : null}
      </View>
      {cli.signIn ? (
        <View style={styles.signIn}>
          <Text style={styles.rowDetail}>
            {cli.signIn.userCode
              ? `Open ${site}'s sign-in page and enter this code:`
              : cli.signIn.needsCode
                ? `Open ${site}'s sign-in page, sign in, then paste the code it shows here.`
                : `Open ${site}'s sign-in page and sign in. This finishes by itself.`}
          </Text>
          {cli.signIn.userCode ? (
            <Text selectable style={styles.code}>
              {cli.signIn.userCode}
            </Text>
          ) : null}
          {cli.signIn.url ? (
            <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]} onPress={() => void Linking.openURL(cli.signIn!.url!)}>
              <Text style={styles.buttonText}>Open the sign-in page</Text>
            </Pressable>
          ) : (
            <Text style={styles.rowDetail}>Waiting for the page…</Text>
          )}
          {cli.signIn.needsCode ? (
            <View style={styles.codeRow}>
              <TextInput
                style={styles.input}
                value={code}
                onChangeText={setCode}
                placeholder="Code from the sign-in page"
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                disabled={busy || !code.trim()}
                style={({ pressed }) => [styles.button, (pressed || busy || !code.trim()) && styles.pressed]}
                onPress={() => run(() => connection.rpc((c) => c["agentClis.submitCode"]({ provider, code })).then(() => setCode("")))}
              >
                <Text style={styles.buttonText}>Continue</Text>
              </Pressable>
            </View>
          ) : null}
          <Pressable hitSlop={8} onPress={() => run(() => connection.rpc((c) => c["agentClis.cancelSignIn"]({ provider })))}>
            <Text style={[styles.actionText, { color: colors.muted, fontSize: 14 }]}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      {shownError ? <Text style={styles.error}>{shownError}</Text> : null}
      {action ? (
        <Pressable disabled={busy} style={({ pressed }) => [styles.action, (pressed || busy) && styles.pressed]} onPress={action.onPress}>
          <Text style={styles.actionText}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.panelSoft, borderRadius: 14, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "500" },
  rowDetail: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  divider: { height: 1, backgroundColor: colors.border },
  action: { paddingHorizontal: 14, paddingBottom: 13, paddingTop: 2 },
  actionText: { color: colors.accent, fontSize: 15 },
  pressed: { opacity: 0.55 },
  hint: { color: colors.muted, fontSize: 12, marginLeft: 4 },
  signIn: { paddingHorizontal: 14, paddingBottom: 12, gap: 10 },
  code: { color: colors.text, fontSize: 24, fontWeight: "600", letterSpacing: 2, fontFamily: "Menlo" },
  codeRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: {
    flex: 1,
    color: colors.text,
    backgroundColor: colors.panel,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  button: { backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 9, alignSelf: "flex-start" },
  buttonText: { color: colors.accent, fontSize: 14, fontWeight: "500" },
  error: { color: colors.red, fontSize: 12, paddingHorizontal: 14, paddingBottom: 10 },
});
