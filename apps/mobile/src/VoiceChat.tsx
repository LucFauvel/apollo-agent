import { sentenceFeed, speakable, type TranscriptItem } from "@apollo/client";
import type { Session, SessionId } from "@apollo/contracts";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { Connection } from "./connection.ts";
import { errorMessage } from "./connection.ts";
import { MicIcon, WaveIcon } from "./icons.tsx";
import { animateLayout } from "./motion.tsx";
import { colors } from "./theme.ts";
import { listen, speak, stopListening, stopSpeaking, subscribeVoice, type VoiceStatus, voiceStatus, whenSpoken } from "./voice.ts";

export const useVoiceStatus = () => {
  const [status, setStatus] = useState<VoiceStatus>(voiceStatus);
  useEffect(() => subscribeVoice(setStatus), []);
  return status;
};

const busy = (s: Session | undefined) => s?.status === "running" || s?.status === "starting" || s?.status === "waiting-approval";

/**
 * Hands-free conversation: listen until the user pauses, send, read the reply aloud as
 * it streams, listen again. Active while `active` is true.
 */
export function useVoiceConversation({
  active,
  sessionId,
  session,
  items,
  connection,
  onError,
}: {
  active: boolean;
  sessionId: SessionId;
  session: Session | undefined;
  items: ReadonlyArray<TranscriptItem>;
  connection: Connection;
  onError: (message: string) => void;
}) {
  // The latest session, for the loop to see status changes.
  const latest = useRef(session);
  latest.current = session;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const replyFinished = () =>
      new Promise<void>((resolve) => {
        let started = busy(latest.current);
        const startedAt = Date.now();
        const timer = setInterval(() => {
          if (cancelled) return finish();
          if (busy(latest.current)) started = true;
          else if (started || Date.now() - startedAt > 15_000) finish();
        }, 300);
        const finish = () => {
          clearInterval(timer);
          resolve();
        };
      });
    void (async () => {
      while (!cancelled) {
        const text = await listen({ silenceMs: 1400 });
        if (cancelled) break;
        if (!text) continue;
        await connection.rpc((c) => c["sessions.send"]({ sessionId, text }));
        await replyFinished();
        await whenSpoken();
      }
    })().catch((error) => {
      if (!cancelled) onError(errorMessage(error));
    });
    return () => {
      cancelled = true;
      stopListening(false);
      void stopSpeaking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, connection]);

  // Read replies that arrive during the conversation, sentence by sentence.
  const known = useRef<Set<string> | null>(null);
  const feeds = useRef(new Map<string, ReturnType<typeof sentenceFeed>>());
  useEffect(() => {
    if (!active) {
      known.current = null;
      feeds.current.clear();
      return;
    }
    if (known.current === null) {
      known.current = new Set(items.map((i) => i.key));
      return;
    }
    for (const item of items) {
      if (known.current.has(item.key)) continue;
      if (item.kind === "assistant") {
        if (item.text.trim() === "[SILENT]") continue;
        let feed = feeds.current.get(item.key);
        if (!feed) feeds.current.set(item.key, (feed = sentenceFeed()));
        const ready = item.streaming ? feed.next(item.text) : feed.finish(item.text);
        if (ready) speak(ready);
        if (!item.streaming) known.current.add(item.key);
      } else if (item.kind === "approval" || item.kind === "input") {
        known.current.add(item.key);
        speak(item.kind === "approval" ? `I need your approval: ${speakable(item.title)}` : speakable(item.message));
      }
    }
  }, [active, items]);
}

/** Mic button in the composer: tap to dictate, tap again (or pause) to finish. */
export function MicButton({ onText, onError, disabled }: { onText: (text: string) => void; onError: (m: string) => void; disabled?: boolean }) {
  const status = useVoiceStatus();
  const [mine, setMine] = useState(false);
  const listening = mine && status.kind === "listening";
  return (
    <Pressable
      hitSlop={6}
      disabled={disabled}
      style={[styles.iconButton, listening && styles.iconButtonLive, disabled && { opacity: 0.4 }]}
      onPress={() => {
        if (listening) return stopListening(true);
        setMine(true);
        listen({ silenceMs: 2500 })
          .then((text) => text && onText(text))
          .catch((e) => onError(errorMessage(e)))
          .finally(() => setMine(false));
      }}
    >
      <MicIcon size={19} color={listening ? colors.red : colors.muted} />
      {listening ? <View style={[styles.ring, { transform: [{ scale: 1 + status.level * 0.4 }] }]} /> : null}
    </Pressable>
  );
}

/** Header button that starts or ends the hands-free conversation. */
export function ConversationToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <Pressable
      hitSlop={10}
      onPress={() => {
        animateLayout();
        onToggle();
      }}
      style={[styles.toggle, active && styles.toggleOn]}
    >
      <WaveIcon size={18} color={active ? colors.accent : colors.muted} />
    </Pressable>
  );
}

/** Above the message box during a conversation: what is happening, tap to skip, End. */
export function ConversationBar({ session, onEnd }: { session: Session | undefined; onEnd: () => void }) {
  const status = useVoiceStatus();
  const label =
    status.kind === "listening"
      ? status.partial || "Listening…"
      : status.kind === "speaking"
        ? "Speaking… tap to skip"
        : session?.status === "waiting-approval"
          ? "Waiting for you…"
          : busy(session)
            ? "Thinking…"
            : "…";
  const bars = [0.5, 0.85, 1, 0.7, 0.45];
  return (
    <View style={styles.bar}>
      <Pressable
        style={styles.barMain}
        onPress={() => {
          if (status.kind === "speaking") void stopSpeaking();
          else if (status.kind === "listening") stopListening(true);
        }}
      >
        {status.kind === "idle" && busy(session) ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <View style={styles.bars}>
            {bars.map((b, i) => (
              <View
                key={i}
                style={[
                  styles.barLine,
                  { height: status.kind === "listening" ? Math.max(3, status.level * b * 18) : status.kind === "speaking" ? 6 + b * 10 : 3 },
                ]}
              />
            ))}
          </View>
        )}
        <Text style={styles.barText} numberOfLines={2}>
          {label}
        </Text>
      </Pressable>
      <Pressable style={styles.end} onPress={onEnd} hitSlop={6}>
        <Text style={styles.endText}>End</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  iconButton: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  iconButtonLive: { backgroundColor: "rgba(248,113,113,0.14)" },
  ring: { position: "absolute", width: 38, height: 38, borderRadius: 19, borderWidth: 2, borderColor: "rgba(248,113,113,0.55)" },
  toggle: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  toggleOn: { backgroundColor: "rgba(129,140,248,0.16)" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 10,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(129,140,248,0.3)",
    backgroundColor: "rgba(129,140,248,0.08)",
  },
  barMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  bars: { flexDirection: "row", alignItems: "center", gap: 3, height: 20 },
  barLine: { width: 3, borderRadius: 2, backgroundColor: colors.accent },
  barText: { flex: 1, color: colors.textSoft, fontSize: 13 },
  end: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  endText: { color: colors.textSoft, fontSize: 12, fontWeight: "600" },
});
