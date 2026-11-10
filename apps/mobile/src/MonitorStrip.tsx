import { monitorStatusLine, runningMonitors } from "@apollo/client";
import type { Monitor, SessionId } from "@apollo/contracts";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useApollo } from "./AppState.tsx";
import { errorMessage } from "./connection.ts";
import { RadarIcon, SquareIcon } from "./icons.tsx";
import { animateLayout, FadeIn, Pulse } from "./motion.tsx";
import { colors } from "./theme.ts";

/** Re-renders every `ms` while `active`, for elapsed times. */
const useNow = (active: boolean, ms = 10_000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
};

/**
 * Above the message box: the monitors this conversation's agent set up (apollo_monitor_start),
 * what each watches, its latest event, and a Stop button (as the desktop app's MonitorStrip).
 * Tapping one shows its command. The agent is told when the user stops one.
 */
export function MonitorStrip({ sessionId }: { sessionId: SessionId }) {
  const { state } = useApollo();
  const monitors = useMemo(() => runningMonitors(state.monitors.values(), sessionId), [state.monitors, sessionId]);
  const now = useNow(monitors.length > 0);
  if (monitors.length === 0) return null;
  return (
    <View style={styles.strip}>
      {monitors.map((m) => (
        <MonitorRow key={m.id} monitor={m} now={now} />
      ))}
    </View>
  );
}

function MonitorRow({ monitor, now }: { monitor: Monitor; now: number }) {
  const { connection } = useApollo();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const stop = () => {
    setStopping(true);
    setError(null);
    connection.rpc((c) => c["monitors.stop"]({ monitorId: monitor.id })).catch((e: unknown) => {
      setStopping(false);
      setError(errorMessage(e));
    });
  };
  return (
    <FadeIn>
      <View style={styles.row}>
        <Pressable
          style={styles.main}
          onPress={() => {
            animateLayout();
            setOpen((o) => !o);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Monitoring: ${monitor.description}`}
          accessibilityHint={open ? "Hides its command" : "Shows its command"}
        >
          <Pulse style={styles.icon}>
            <RadarIcon size={16} color={colors.green} />
          </Pulse>
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={open ? undefined : 1}>
              Monitoring: {monitor.description}
            </Text>
            <Text style={styles.status} numberOfLines={1}>
              {monitorStatusLine(monitor, now)}
            </Text>
            {error ? (
              <Text style={styles.error} numberOfLines={2}>
                {error}
              </Text>
            ) : monitor.lastEvent ? (
              <Text style={styles.event} numberOfLines={open ? 4 : 1}>
                {monitor.lastEvent}
              </Text>
            ) : null}
            {open ? (
              <Text style={styles.command} selectable>
                {monitor.command}
                {"\n"}in {monitor.cwd}
              </Text>
            ) : null}
          </View>
        </Pressable>
        <Pressable
          onPress={stop}
          disabled={stopping}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Stop monitoring ${monitor.description}`}
          style={({ pressed }) => [styles.stop, (pressed || stopping) && { opacity: 0.5 }]}
        >
          <SquareIcon size={11} color={colors.textSoft} />
          <Text style={styles.stopText}>{stopping ? "Stopping…" : "Stop"}</Text>
        </Pressable>
      </View>
    </FadeIn>
  );
}

const mono = { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" };

const styles = StyleSheet.create({
  strip: { marginHorizontal: 10, marginTop: 8, gap: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(52,211,153,0.25)",
    backgroundColor: "rgba(52,211,153,0.06)",
  },
  main: { flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 10, minWidth: 0 },
  icon: { paddingTop: 1 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: "#d1fae5", fontSize: 13, fontWeight: "600" },
  status: { color: colors.faint, fontSize: 11 },
  event: { ...mono, color: colors.muted, fontSize: 11 },
  error: { color: colors.red, fontSize: 11 },
  command: { ...mono, color: colors.textSoft, fontSize: 11, marginTop: 4 },
  stop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stopText: { color: colors.textSoft, fontSize: 12, fontWeight: "600" },
});
