import type { BotId, BrowserFrame, BrowserInput, SessionId } from "@apollo/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  type LayoutChangeEvent,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApollo } from "../AppState.tsx";
import { errorMessage } from "../connection.ts";
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, BackspaceIcon, CheckIcon, EnterIcon, HandIcon, RotateCwIcon, XIcon } from "../icons.tsx";
import { FadeIn, Pulse, useKeyboardInset } from "../motion.tsx";
import { colors } from "../theme.ts";

/**
 * Apollo's browser on the phone: a bot's tabs, live. Taps click, drags scroll, and the
 * field below types into the page, so the user can take over what an agent handed them
 * (a CAPTCHA, a 2FA code, a sign-in) and tell it they are done.
 */

export interface Handoff {
  readonly sessionId: SessionId;
  readonly requestId: string;
  readonly reason: string;
}

const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === "about:" ? "New tab" : u.host;
  } catch {
    return url;
  }
};

/** Movement under this many points is a tap, not a scroll. */
const TAP_SLOP = 8;

export function BrowserScreen({
  botId,
  tabId: initialTabId,
  handoff,
  onBack,
}: {
  botId: BotId;
  tabId?: string | undefined;
  handoff?: Handoff | undefined;
  onBack: () => void;
}) {
  const { state, connection } = useApollo();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset(insets.bottom);
  const tabs = useMemo(
    () => [...state.browserTabs.values()].filter((t) => t.botId === botId).sort((a, b) => a.openedAt - b.openedAt),
    [state.browserTabs, botId],
  );
  const [selectedId, setSelectedId] = useState<string | undefined>(initialTabId);
  const tab = tabs.find((t) => t.id === selectedId) ?? tabs.at(-1) ?? null;

  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);

  // Live frames while the screen is open.
  useEffect(() => {
    if (!tab) return;
    setFrame(null);
    return connection.follow(
      (c) => c["browser.watch"]({ tabId: tab.id }),
      (next) => setFrame(next),
    );
  }, [connection, tab?.id]);

  const send = (input: BrowserInput) => {
    if (!tab) return;
    connection.rpc((c) => c["browser.input"]({ tabId: tab.id, input })).then(
      () => setError(null),
      (e) => setError(errorMessage(e)),
    );
  };

  // Taps click where they land; drags scroll the page under the finger.
  const size = useRef({ width: 1, height: 1 });
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const sendRef = useRef(send);
  sendRef.current = send;
  const scrolled = useRef({ dx: 0, dy: 0 });
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          scrolled.current = { dx: 0, dy: 0 };
        },
        onPanResponderMove: (e, g) => {
          if (Math.abs(g.dx) < TAP_SLOP && Math.abs(g.dy) < TAP_SLOP) return;
          // Page pixels per screen point.
          const scale = (frameRef.current?.width ?? size.current.width) / size.current.width;
          const dx = (scrolled.current.dx - g.dx) * scale;
          const dy = (scrolled.current.dy - g.dy) * scale;
          if (Math.abs(dy) < 24 && Math.abs(dx) < 24) return;
          scrolled.current = { dx: g.dx, dy: g.dy };
          const { locationX, locationY } = e.nativeEvent;
          sendRef.current({
            _tag: "scroll",
            x: locationX / size.current.width,
            y: locationY / size.current.height,
            deltaX: Math.round(dx),
            deltaY: Math.round(dy),
          });
        },
        onPanResponderRelease: (e, g) => {
          if (Math.abs(g.dx) >= TAP_SLOP || Math.abs(g.dy) >= TAP_SLOP) return;
          const { locationX, locationY } = e.nativeEvent;
          sendRef.current({ _tag: "click", x: locationX / size.current.width, y: locationY / size.current.height });
        },
      }),
    [],
  );

  const respond = (outcome: "done" | "cancelled") => {
    if (!handoff) return;
    setBusy(true);
    connection
      .rpc((c) =>
        c["browser.handoffRespond"]({
          sessionId: handoff.sessionId,
          requestId: handoff.requestId,
          outcome,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      )
      .then(
        () => {
          setAnswered(true);
          onBack();
        },
        (e) => setError(errorMessage(e)),
      )
      .finally(() => setBusy(false));
  };

  const typeText = () => {
    if (!text) return;
    send({ _tag: "text", text });
    setText("");
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
    <Animated.View style={{ flex: 1, paddingBottom: keyboard }}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            {tab ? tab.title || hostOf(tab.url) : "Browser"}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {tab ? hostOf(tab.url) : "No open tabs"}
            {tab?.loading ? " · loading…" : ""}
          </Text>
        </View>
        <Pressable hitSlop={8} onPress={() => send({ _tag: "history", direction: "back" })} style={styles.navButton}>
          <ArrowLeftIcon size={18} color={colors.muted} />
        </Pressable>
        <Pressable hitSlop={8} onPress={() => send({ _tag: "history", direction: "forward" })} style={styles.navButton}>
          <ArrowRightIcon size={18} color={colors.muted} />
        </Pressable>
        <Pressable hitSlop={8} onPress={() => send({ _tag: "history", direction: "reload" })} style={styles.navButton}>
          <RotateCwIcon size={17} color={colors.muted} />
        </Pressable>
      </View>

      {tabs.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabStrip} contentContainerStyle={styles.tabStripContent}>
          {tabs.map((t) => (
            <Pressable key={t.id} onPress={() => setSelectedId(t.id)} style={[styles.tabChip, t.id === tab?.id && styles.tabChipActive]}>
              <Text style={[styles.tabChipText, t.id === tab?.id && { color: colors.text }]} numberOfLines={1}>
                {hostOf(t.url)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.viewport} scrollEnabled={false}>
        {!tab ? (
          <Text style={styles.empty}>Nothing is open. Agents open tabs as they browse.</Text>
        ) : frame ? (
          <View
            {...pan.panHandlers}
            onLayout={(e: LayoutChangeEvent) => {
              size.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
            }}
            style={[styles.frame, { aspectRatio: frame.width / frame.height }]}
          >
            <Image source={{ uri: `data:image/jpeg;base64,${frame.data}` }} style={StyleSheet.absoluteFill} resizeMode="contain" fadeDuration={0} />
          </View>
        ) : (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.muted} />
          </View>
        )}
      </ScrollView>

      {tab ? (
        <View style={styles.keys}>
          <TextInput
            style={styles.typeInput}
            value={text}
            onChangeText={setText}
            onSubmitEditing={typeText}
            placeholder="Type into the page"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
          />
          <Pressable style={[styles.keyButton, !text && { opacity: 0.4 }]} onPress={typeText} disabled={!text}>
            <ArrowUpIcon size={16} strokeWidth={2.5} color={colors.text} />
          </Pressable>
          <Pressable style={styles.keyButton} onPress={() => send({ _tag: "key", key: "Backspace" })}>
            <BackspaceIcon size={16} color={colors.textSoft} />
          </Pressable>
          <Pressable style={styles.keyButton} onPress={() => send({ _tag: "key", key: "Enter" })}>
            <EnterIcon size={16} color={colors.textSoft} />
          </Pressable>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {handoff && !answered ? (
        <FadeIn>
        <View style={styles.handoff}>
          <View style={styles.handoffRow}>
            <Pulse>
              <HandIcon size={16} color="#7dd3fc" />
            </Pulse>
            <Text style={styles.handoffText} numberOfLines={3}>
              {handoff.reason}
            </Text>
          </View>
          <View style={styles.handoffRow}>
            <TextInput
              style={styles.noteInput}
              value={note}
              onChangeText={setNote}
              placeholder="Note for the agent (optional)"
              placeholderTextColor={colors.faint}
            />
            <Pressable style={[styles.doneButton, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => respond("done")}>
              <CheckIcon size={15} strokeWidth={2.5} color={colors.bg} />
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
            <Pressable style={styles.cancelButton} disabled={busy} onPress={() => respond("cancelled")} accessibilityLabel="I won't do it">
              <XIcon size={16} color={colors.muted} />
            </Pressable>
          </View>
        </View>
        </FadeIn>
      ) : null}
    </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  back: { color: colors.muted, fontSize: 16 },
  title: { color: colors.text, fontSize: 15, fontWeight: "600" },
  meta: { color: colors.faint, fontSize: 12 },
  navButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  tabStrip: { flexGrow: 0 },
  tabStripContent: { gap: 6, paddingHorizontal: 16, paddingBottom: 8 },
  tabChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: "#27272a", maxWidth: 180 },
  tabChipActive: { backgroundColor: "#27272a", borderColor: "#3f3f46" },
  tabChipText: { color: colors.muted, fontSize: 12 },
  viewport: { flexGrow: 1, paddingHorizontal: 8, justifyContent: "center" },
  frame: { width: "100%", borderRadius: 10, overflow: "hidden", backgroundColor: "#fff", borderWidth: 1, borderColor: "#27272a" },
  loading: { height: 240, alignItems: "center", justifyContent: "center" },
  empty: { color: colors.faint, textAlign: "center", fontSize: 13, paddingHorizontal: 32 },
  keys: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingTop: 8 },
  typeInput: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    backgroundColor: "#18181b",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#27272a",
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  keyButton: { width: 38, height: 38, borderRadius: 10, backgroundColor: "#27272a", alignItems: "center", justifyContent: "center" },
  error: { color: "#f87171", fontSize: 12, paddingHorizontal: 16, paddingTop: 6 },
  handoff: {
    margin: 12,
    marginBottom: 4,
    padding: 12,
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(2,132,199,0.45)",
    backgroundColor: "rgba(8,47,73,0.35)",
  },
  handoffRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  handoffText: { flex: 1, color: "#e0f2fe", fontSize: 13, lineHeight: 18 },
  noteInput: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    backgroundColor: "#0c0a09",
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "#27272a",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  doneButton: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#7dd3fc", borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8 },
  doneText: { color: colors.bg, fontWeight: "600", fontSize: 13 },
  cancelButton: { width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: "#27272a" },
});
