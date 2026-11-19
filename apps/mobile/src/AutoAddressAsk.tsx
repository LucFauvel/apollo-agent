import { autoAddressAsks, prSessionIds } from "@apollo/client";
import type { PullRequest, Session, SessionId } from "@apollo/contracts";
import { useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useApollo } from "./AppState.tsx";
import { errorMessage } from "./connection.ts";
import { GitPullRequestIcon } from "./icons.tsx";
import { FadeIn } from "./motion.tsx";
import { colors } from "./theme.ts";

const SKY = "#7dd3fc";

/**
 * Above the message box: PRs the agents linked whose user has not said yet whether the agent
 * should address their review comments (as the desktop app's AutoAddressAsk). Auto-address
 * starts off; nothing waits for this.
 */
export function AutoAddressAsk({ session }: { session: Session }) {
  const { state } = useApollo();
  const asks = useMemo(
    () => autoAddressAsks(state.pullRequestReviews, state.pullRequests, prSessionIds(session, state.sessions.values())),
    [state.pullRequestReviews, state.pullRequests, state.sessions, session],
  );
  if (asks.length === 0) return null;
  return (
    <View style={styles.strip}>
      {asks.map((ask) => (
        <AskRow key={`${ask.sessionId} ${ask.url}`} sessionId={ask.sessionId} pr={ask.pr} />
      ))}
    </View>
  );
}

function AskRow({ sessionId, pr }: { sessionId: SessionId; pr: PullRequest }) {
  const { connection } = useApollo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (enabled: boolean) => {
    setBusy(true);
    setError(null);
    connection.rpc((c) => c["pullRequests.setAutoAddress"]({ sessionId, url: pr.url, enabled })).catch((e: unknown) => {
      setBusy(false);
      setError(errorMessage(e));
    });
  };
  return (
    <FadeIn>
      <View style={styles.card}>
        <Pressable style={styles.main} onPress={() => void Linking.openURL(pr.url)} accessibilityRole="link">
          <GitPullRequestIcon size={16} color={SKY} />
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={1}>
              Address review comments on {pr.repo}#{pr.number}?
            </Text>
            <Text style={error ? styles.error : styles.detail} numberOfLines={2}>
              {error ?? "The agent would fix or answer new comments, push, and reply on GitHub under your account."}
            </Text>
          </View>
        </Pressable>
        <View style={styles.buttons}>
          <Pressable
            onPress={() => answer(false)}
            disabled={busy}
            hitSlop={6}
            accessibilityRole="button"
            style={({ pressed }) => [styles.button, (pressed || busy) && styles.dim]}
          >
            <Text style={styles.notNow}>Not now</Text>
          </Pressable>
          <Pressable
            onPress={() => answer(true)}
            disabled={busy}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`Turn on auto-address for ${pr.repo}#${pr.number}`}
            style={({ pressed }) => [styles.button, styles.turnOn, (pressed || busy) && styles.dim]}
          >
            <Text style={styles.turnOnText}>Turn on</Text>
          </Pressable>
        </View>
      </View>
    </FadeIn>
  );
}

const styles = StyleSheet.create({
  strip: { marginHorizontal: 10, marginTop: 8, gap: 6 },
  card: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(56,189,248,0.25)",
    backgroundColor: "rgba(56,189,248,0.06)",
    gap: 8,
  },
  main: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: "#e0f2fe", fontSize: 13, fontWeight: "600" },
  detail: { color: colors.faint, fontSize: 11 },
  error: { color: colors.red, fontSize: 11 },
  buttons: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  button: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10 },
  turnOn: { backgroundColor: "rgba(56,189,248,0.2)" },
  dim: { opacity: 0.5 },
  notNow: { color: colors.muted, fontSize: 12 },
  turnOnText: { color: "#e0f2fe", fontSize: 12, fontWeight: "600" },
});
