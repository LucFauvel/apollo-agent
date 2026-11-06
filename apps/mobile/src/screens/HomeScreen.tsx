import type { Session, SessionId } from "@apollo/contracts";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApollo } from "../AppState.tsx";
import { BlobAvatar } from "../BlobAvatar.tsx";
import { colors } from "../theme.ts";

const busy = (s: Session) => s.status === "running" || s.status === "starting" || s.status === "waiting-approval";

const statusText = (s: Session) =>
  s.status === "waiting-approval" ? "Needs you" : busy(s) ? "Working…" : s.status === "error" ? "Error" : null;

const statusColor = (s: Session) => (s.status === "waiting-approval" ? colors.amber : s.status === "error" ? colors.red : colors.green);

/** Bots with their orchestrator, and the workers still active under each. */
export function HomeScreen({ onOpen, onUnpair }: { onOpen: (id: SessionId) => void; onUnpair: () => void }) {
  const { state } = useApollo();
  const sessions = [...state.sessions.values()];
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Apollo</Text>
        <View style={[styles.dot, { backgroundColor: state.connected ? colors.green : colors.amber }]} />
        <Text style={styles.connection}>{state.connected ? "Connected" : "Connecting…"}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {[...state.bots.values()].map((bot) => {
          const main = state.sessions.get(bot.mainSessionId);
          const workers = sessions.filter((s) => s.botId === bot.id && s.role === "worker" && (busy(s) || s.completedTurns === 0));
          const mainStatus = main ? statusText(main) : null;
          return (
            <View key={bot.id} style={styles.card}>
              <Pressable style={({ pressed }) => [styles.botRow, pressed && styles.pressed]} onPress={() => onOpen(bot.mainSessionId)}>
                <BlobAvatar avatar={bot.avatar} size={40} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.botName}>{bot.name}</Text>
                  <Text style={styles.botMeta} numberOfLines={1}>
                    {main?.lastMessage?.replace(/\s+/g, " ").slice(0, 80) ?? "No messages yet"}
                  </Text>
                </View>
                {mainStatus && main ? <Text style={[styles.status, { color: statusColor(main) }]}>{mainStatus}</Text> : null}
              </Pressable>
              {workers.map((w) => (
                <Pressable key={w.id} style={({ pressed }) => [styles.workerRow, pressed && styles.pressed]} onPress={() => onOpen(w.id)}>
                  <Text style={styles.workerTitle} numberOfLines={1}>
                    {w.title}
                  </Text>
                  {statusText(w) ? <Text style={[styles.status, { color: statusColor(w) }]}>{statusText(w)}</Text> : null}
                </Pressable>
              ))}
            </View>
          );
        })}
        {state.connected && state.bots.size === 0 ? (
          <Text style={styles.empty}>No bots yet. Create one in Apollo on your computer.</Text>
        ) : null}
        <Pressable onPress={onUnpair} style={styles.unpair}>
          <Text style={styles.unpairText}>Unpair this phone</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingVertical: 12 },
  title: { color: colors.text, fontSize: 24, fontWeight: "700", flex: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  connection: { color: colors.muted, fontSize: 12 },
  list: { padding: 16, gap: 12 },
  card: { backgroundColor: colors.panelSoft, borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  pressed: { opacity: 0.55 },
  botRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  botName: { color: colors.text, fontSize: 16, fontWeight: "600" },
  botMeta: { color: colors.faint, fontSize: 13, marginTop: 2 },
  status: { fontSize: 12, fontWeight: "600" },
  workerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  workerTitle: { color: colors.textSoft, fontSize: 14, flex: 1 },
  empty: { color: colors.muted, textAlign: "center", marginTop: 40 },
  unpair: { alignSelf: "center", marginTop: 24, padding: 10 },
  unpairText: { color: colors.faint, fontSize: 13 },
});
