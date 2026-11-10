import { gapAt, moveToGap } from "@apollo/client";
import { type Bot, type BotId, type Session, type SessionId, sortBots } from "@apollo/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, type HostInstance, type LayoutRectangle, PanResponder, Pressable, ScrollView, type ScrollViewInstance, StyleSheet, Text, View } from "react-native";
import { errorMessage } from "../connection.ts";
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

/** How long a press must last before the bot lifts for dragging (the platform's long-press). */
const LONG_PRESS_MS = 350;
/** Within this distance of the list's top or bottom edge, a drag scrolls the list. */
const SCROLL_EDGE = 72;
const SCROLL_STEP = 10;

/**
 * Long-press a bot, then drag it to reorder the list (core React Native: Pressable's long press
 * starts it, a PanResponder on the list follows the finger). The lifted card follows the finger,
 * a line shows where it will land, and the list scrolls near its edges. Taps still open the bot,
 * and scrolling works as before: the list only stops scrolling while a bot is lifted.
 */
function useBotDrag(ordered: ReadonlyArray<Bot>, reorder: (order: ReadonlyArray<BotId>) => Promise<void>) {
  const [dragId, setDragId] = useState<BotId | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const translateY = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<ScrollViewInstance>(null);
  const listRef = useRef<HostInstance>(null);
  const layouts = useRef(new Map<BotId, LayoutRectangle>());
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  // The PanResponder is made once: it reaches the latest list and connection through refs.
  const reorderRef = useRef(reorder);
  reorderRef.current = reorder;
  const scroll = useRef({ y: 0, contentHeight: 0, viewHeight: 0, windowTop: 0 });
  /** The drag under way: who, where it started, and the finger's last offset and edge. */
  const drag = useRef<{ id: BotId; center: number; startScroll: number; dy: number; edge: -1 | 0 | 1; panning: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);
  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);

  const rows = () =>
    orderedRef.current.map((b) => {
      const l = layouts.current.get(b.id);
      return l ? { top: l.y, bottom: l.y + l.height } : { top: 0, bottom: 0 };
    });

  /** Moves the lifted card under the finger and picks the gap at its center. */
  const follow = () => {
    const d = drag.current;
    if (!d) return;
    const scrolled = scroll.current.y - d.startScroll;
    translateY.setValue(d.dy + scrolled);
    const next = gapAt(rows(), d.center + d.dy + scrolled);
    setGap((g) => (g === next ? g : next));
  };

  const commit = (order: ReadonlyArray<BotId>) => {
    setError(null);
    reorderRef.current(order).catch((e: unknown) => setError(errorMessage(e)));
  };

  const finish = (apply: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setDragId(null);
    setGap(null);
    translateY.setValue(0);
    if (!d || !apply) return;
    const ids = orderedRef.current.map((b) => b.id);
    const from = ids.indexOf(d.id);
    const target = gapAt(rows(), d.center + d.dy + scroll.current.y - d.startScroll);
    const next = moveToGap(ids, from, target);
    if (next !== ids) commit(next);
  };

  const begin = (id: BotId) => {
    const layout = layouts.current.get(id);
    if (!layout) return;
    drag.current = { id, center: layout.y + layout.height / 2, startScroll: scroll.current.y, dy: 0, edge: 0, panning: false };
    translateY.setValue(0);
    setDragId(id);
    setGap(orderedRef.current.findIndex((b) => b.id === id));
    listRef.current?.measureInWindow((_x, y) => void (scroll.current.windowTop = y));
    timer.current = setInterval(() => {
      const d = drag.current;
      if (!d || d.edge === 0) return;
      const s = scroll.current;
      const max = Math.max(0, s.contentHeight - s.viewHeight);
      const y = Math.min(max, Math.max(0, s.y + d.edge * SCROLL_STEP));
      if (y === s.y) return;
      s.y = y;
      scrollRef.current?.scrollTo({ y, animated: false });
      follow();
    }, 16);
  };

  /** The press ended: if no drag followed the long press (lifted without moving), drop it. */
  const pressOut = () =>
    setTimeout(() => {
      if (drag.current && !drag.current.panning) finish(false);
    }, 0);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // Only while a bot is lifted: then the list takes the finger from the card's Pressable.
        onMoveShouldSetPanResponderCapture: () => drag.current !== null,
        onMoveShouldSetPanResponder: () => drag.current !== null,
        onPanResponderGrant: () => {
          if (drag.current) drag.current.panning = true;
        },
        onPanResponderMove: (_e, g) => {
          const d = drag.current;
          if (!d) return;
          d.dy = g.dy;
          const s = scroll.current;
          d.edge = g.moveY < s.windowTop + SCROLL_EDGE ? -1 : g.moveY > s.windowTop + s.viewHeight - SCROLL_EDGE ? 1 : 0;
          follow();
        },
        onPanResponderRelease: () => finish(true),
        onPanResponderTerminate: () => finish(false),
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );

  /** VoiceOver / TalkBack: move a bot one place up or down. */
  const move = (id: BotId, delta: -1 | 1) => {
    const ids = orderedRef.current.map((b) => b.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    commit(moveToGap(ids, from, delta < 0 ? to : to + 1));
  };

  /** Where the drop line goes (content coordinates), or null when the bot would stay put. */
  const lineY = (() => {
    if (dragId === null || gap === null) return null;
    const from = ordered.findIndex((b) => b.id === dragId);
    if (gap === from || gap === from + 1) return null;
    const below = ordered[gap];
    const above = ordered[gap - 1];
    const l = below ? layouts.current.get(below.id) : undefined;
    if (l) return l.y - 7.5;
    const a = above ? layouts.current.get(above.id) : undefined;
    return a ? a.y + a.height + 4.5 : null;
  })();

  return {
    dragId,
    lineY,
    error,
    translateY,
    scrollRef,
    listRef,
    panHandlers: pan.panHandlers,
    begin,
    pressOut,
    move,
    onCardLayout: (id: BotId, layout: LayoutRectangle) => void layouts.current.set(id, layout),
    scrollProps: {
      scrollEnabled: dragId === null,
      scrollEventThrottle: 16,
      onScroll: (e: { nativeEvent: { contentOffset: { y: number } } }) => {
        scroll.current.y = e.nativeEvent.contentOffset.y;
      },
      onContentSizeChange: (_w: number, h: number) => void (scroll.current.contentHeight = h),
      onLayout: (e: { nativeEvent: { layout: LayoutRectangle } }) => void (scroll.current.viewHeight = e.nativeEvent.layout.height),
    },
  };
}

/** Bots with their orchestrator and active workers; finished workers below; settings behind the gear. */
export function HomeScreen({
  onOpen,
  onSettings,
}: {
  onOpen: (id: SessionId) => void;
  onSettings: () => void;
}) {
  const { state, reorderBots } = useApollo();
  const sessions = [...state.sessions.values()];
  const ordered = useMemo(() => sortBots(state.bots.values()), [state.bots]);
  const drag = useBotDrag(ordered, reorderBots);
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
      {drag.error ? <Text style={styles.error}>Could not save the new order: {drag.error}</Text> : null}
      <View ref={drag.listRef} style={{ flex: 1 }} {...drag.panHandlers}>
        <ScrollView ref={drag.scrollRef} contentContainerStyle={styles.list} {...drag.scrollProps}>
          {ordered.map((bot) => {
            const main = state.sessions.get(bot.mainSessionId);
            const workers = sessions.filter((s) => s.botId === bot.id && s.role === "worker" && (busy(s) || s.completedTurns === 0));
            const mainStatus = main ? statusText(main) : null;
            const lifted = drag.dragId === bot.id;
            return (
              <Animated.View
                key={bot.id}
                onLayout={(e) => drag.onCardLayout(bot.id, e.nativeEvent.layout)}
                style={[styles.card, lifted && [styles.lifted, { transform: [{ translateY: drag.translateY }, { scale: 1.03 }] }]]}
              >
                <Pressable
                  style={({ pressed }) => [styles.botRow, pressed && !lifted && styles.pressed]}
                  onPress={() => onOpen(bot.mainSessionId)}
                  onLongPress={() => drag.begin(bot.id)}
                  delayLongPress={LONG_PRESS_MS}
                  onPressOut={drag.pressOut}
                  accessibilityRole="button"
                  accessibilityHint="Long-press and drag to reorder"
                  accessibilityActions={[
                    { name: "moveUp", label: "Move up" },
                    { name: "moveDown", label: "Move down" },
                  ]}
                  onAccessibilityAction={(e) => drag.move(bot.id, e.nativeEvent.actionName === "moveUp" ? -1 : 1)}
                >
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
              </Animated.View>
            );
          })}
          {drag.lineY !== null ? <View pointerEvents="none" style={[styles.dropLine, { top: drag.lineY }]} /> : null}
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
  lifted: { zIndex: 10, elevation: 8, borderColor: colors.accent, shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
  dropLine: { position: "absolute", left: 20, right: 20, height: 3, borderRadius: 2, backgroundColor: colors.accent },
  error: { color: colors.red, fontSize: 13, paddingHorizontal: 20, paddingBottom: 6 },
  gear: { marginLeft: 6, padding: 2 },
  finished: { marginTop: 12, gap: 8 },
  finishedHeader: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 4, paddingVertical: 4 },
  chevron: { color: colors.faint, fontSize: 11, width: 10 },
  finishedTitle: { color: colors.faint, fontSize: 12, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase", flex: 1 },
  finishedCount: { color: colors.faint, fontSize: 12 },
  finishedMeta: { color: colors.faint, fontSize: 12, marginTop: 2 },
});
