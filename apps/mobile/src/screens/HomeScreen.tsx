import type { Session, SessionId } from "@apollo/contracts";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ArchiveIcon, GearIcon } from "../icons.tsx";
import { animateLayout } from "../motion.tsx";
import { useApollo } from "../AppState.tsx";
import { BlobAvatar } from "../BlobAvatar.tsx";
import { colors } from "../theme.ts";

const busy = (s: Session) => s.status === "running" || s.status === "starting" || s.status === "waiting-approval";

const statusText = (s: Session) =>
  s.status === "waiting-approval" ? "Needs you" : busy(s) ? "Working…" : s.status === "error" ? "Error" : null;

const statusColor = (s: Session) => (s.status === "waiting-approval" ? colors.amber : s.status === "error" ? colors.red : colors.green);

/** A worker that did its work and is not doing anything now: it moves to Finished. */
const isFinished = (s: Session) => s.role === "worker" && !busy(s) && s.completedTurns > 0;

/** Finished workers of every bot, newest first, collapsed at the bottom. */
function FinishedSection({ sessions, botName, onOpen }: { sessions: Array<Session>; botName: (s: Session) => string; onOpen: (id: SessionId) => void }) {
  const [open, setOpen] = useState(false);
  if (sessions.length === 0) return null;
  return (
    <View style={styles.finished}>
      <Pressable
        hitSlop={6}
        style={styles.finishedHeader}
        onPress={() => {
          animateLayout();
          setOpen(!open);
        }}
      >
        <Text style={styles.chevron}>{open ? "▾" : "▸"}</Text>
        <ArchiveIcon size={14} color={colors.faint} />
        <Text style={styles.finishedTitle}>Finished</Text>
        <Text style={styles.finishedCount}>{sessions.length}</Text>
      </Pressable>
      {open ? (
        <View style={styles.card}>
          {sessions.map((w, i) => (
            <Pressable
              key={w.id}
              style={({ pressed }) => [styles.workerRow, i === 0 && { borderTopWidth: 0 }, pressed && styles.pressed]}
              onPress={() => onOpen(w.id)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.workerTitle} numberOfLines={1}>
                  {w.title}
                </Text>
                <Text style={styles.finishedMeta} numberOfLines={1}>
                  {botName(w)}
                  {w.lastMessage ? ` · ${w.lastMessage.replace(/\s+/g, " ").slice(0, 70)}` : ""}
                </Text>
              </View>
              {w.status === "error" ? <Text style={[styles.status, { color: colors.red }]}>Error</Text> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Bots with their orchestrator and active workers; finished workers below; settings behind the gear. */
export function HomeScreen({
  onOpen,
  onSettings,
}: {
  onOpen: (id: SessionId) => void;
  onSettings: () => void;
}) {
  const { state } = useApollo();
  const sessions = [...state.sessions.values()];
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Apollo</Text>
        <View style={[styles.dot, { backgroundColor: state.connected ? colors.green : colors.amber }]} />
        <Text style={styles.connection}>{state.connected ? "Connected" : "Connecting…"}</Text>
        <Pressable hitSlop={10} onPress={onSettings} style={styles.gear} accessibilityLabel="Settings">
          <GearIcon size={20} color={colors.muted} />
        </Pressable>
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
        <FinishedSection
          sessions={sessions.filter(isFinished).sort((a, b) => b.updatedAt - a.updatedAt)}
          botName={(w) => state.bots.get(w.botId)?.name ?? "Bot"}
          onOpen={onOpen}
        />
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
  gear: { marginLeft: 6, padding: 2 },
  finished: { marginTop: 12, gap: 8 },
  finishedHeader: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 4, paddingVertical: 4 },
  chevron: { color: colors.faint, fontSize: 11, width: 10 },
  finishedTitle: { color: colors.faint, fontSize: 12, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase", flex: 1 },
  finishedCount: { color: colors.faint, fontSize: 12 },
  finishedMeta: { color: colors.faint, fontSize: 12, marginTop: 2 },
});
