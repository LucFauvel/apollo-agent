import { sentenceFeed, speakable } from "@apollo/client";
import type { Session } from "@apollo/contracts";
import { AudioLines, Loader2, Mic, Square, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { errorMessage, rpc } from "../rpc.ts";
import { getAppState, subscribeApp } from "../store.ts";
import type { TranscriptItem } from "../transcript.ts";
import {
  availableVoices,
  isListening,
  loadPrefs,
  modelState,
  preloadModel,
  savePrefs,
  SPEECH_MODELS,
  listen,
  setConversation,
  speak,
  stopListening,
  stopSpeaking,
  subscribeVoice,
  voiceState,
  whenSpoken,
} from "../voice/voice.ts";
import { Button, cx, Field, FormSection, inputClass, Tooltip } from "./ui.tsx";

export const useVoice = () => useSyncExternalStore(subscribeVoice, voiceState);

const busy = (s: Session | undefined) => s?.status === "running" || s?.status === "starting" || s?.status === "waiting-approval";

/** Resolves once the session has worked on the message and gone quiet again. */
const replyFinished = (sessionId: string) =>
  new Promise<void>((resolve) => {
    let started = busy(getAppState().sessions.get(sessionId as Session["id"]));
    // A reply can finish before the first status change arrives: give up waiting to see it start.
    const fallback = setTimeout(() => !started && done(), 15_000);
    const check = () => {
      const session = getAppState().sessions.get(sessionId as Session["id"]);
      if (busy(session)) started = true;
      else if (started) done();
    };
    const stop = subscribeApp(check);
    const done = () => {
      clearTimeout(fallback);
      stop();
      resolve();
    };
    check();
  });

/**
 * Voice conversation with a session: listen until the user pauses, send what they said,
 * read the reply aloud as it streams, then listen again. Runs while the session is the
 * one in conversation mode.
 */
export function useConversation(session: Session, items: ReadonlyArray<TranscriptItem>, onError: (message: string) => void) {
  const { conversation } = useVoice();
  const active = conversation === session.id;

  // The loop: listen → send → wait for the reply to finish and be read → again.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      while (!cancelled) {
        const text = await listen({ untilSilence: true });
        if (cancelled) break;
        if (!text) continue;
        await rpc((c) => c["sessions.send"]({ sessionId: session.id, text }));
        await replyFinished(session.id);
        await whenSpoken();
      }
    })().catch((error) => {
      if (cancelled) return;
      onError(errorMessage(error));
      setConversation(null);
    });
    return () => {
      cancelled = true;
      stopListening(false);
      stopSpeaking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, session.id]);

  // Reading: replies that arrive while in conversation mode, sentence by sentence.
  const known = useRef<Set<string> | null>(null);
  const feeds = useRef(new Map<string, ReturnType<typeof sentenceFeed>>());
  useEffect(() => {
    if (!active) {
      known.current = null;
      feeds.current.clear();
      return;
    }
    // Replies already there when the mode started are not read.
    if (known.current === null) {
      known.current = new Set(items.filter((i) => i.kind === "assistant").map((i) => i.key));
      return;
    }
    for (const item of items) {
      if (item.kind !== "assistant" || known.current.has(item.key)) continue;
      if (item.text.trim() === "[SILENT]") continue;
      let feed = feeds.current.get(item.key);
      if (!feed) feeds.current.set(item.key, (feed = sentenceFeed()));
      const ready = item.streaming ? feed.next(item.text) : feed.finish(item.text);
      if (ready) speak(ready);
      if (!item.streaming) known.current.add(item.key);
    }
    // Something needs the user: say so, since they may not be looking.
    const last = items.at(-1);
    if (last && !known.current.has(last.key) && (last.kind === "approval" || last.kind === "input")) {
      known.current.add(last.key);
      speak(last.kind === "approval" ? `I need your approval: ${speakable(last.title)}` : speakable(last.message));
    }
  }, [active, items]);
}

/** Microphone button: press to dictate into the message box, press again to stop. */
export function DictateButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const { status, conversation } = useVoice();
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const recording = mine && status.kind === "listening";
  const working = mine && (status.kind === "transcribing" || status.kind === "loading");

  const toggle = () => {
    setError(null);
    if (recording) {
      stopListening(true);
      return;
    }
    if (working) return;
    setMine(true);
    listen({ untilSilence: false })
      .then((text) => text && onText(text))
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setMine(false));
  };

  // Esc while dictating throws the recording away.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && stopListening(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording]);

  const label = error
    ? `Dictation failed: ${error}`
    : recording
      ? "Stop and transcribe (Esc to cancel)"
      : working
        ? status.kind === "loading"
          ? `Downloading the speech model (${status.percent}%)…`
          : "Transcribing…"
        : "Dictate (speech is transcribed on this computer)";
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={toggle}
        disabled={disabled || conversation !== null}
        className={cx(
          "relative flex size-7 items-center justify-center rounded-lg transition-colors disabled:opacity-40",
          recording ? "bg-red-500/15 text-red-300" : error ? "text-red-400 hover:bg-zinc-800" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
        )}
      >
        {working ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
        {recording ? (
          <span
            className="pointer-events-none absolute inset-0 rounded-lg ring-2 ring-red-400/60 transition-transform duration-75"
            style={{ transform: `scale(${1 + status.level * 0.35})` }}
          />
        ) : null}
      </button>
    </Tooltip>
  );
}

/** Starts or ends a hands-free voice conversation with the session. */
export function ConversationButton({ session, disabled }: { session: Session; disabled?: boolean }) {
  const { conversation } = useVoice();
  const active = conversation === session.id;
  return (
    <Tooltip
      content={
        active ? (
          "End the voice conversation"
        ) : (
          <>
            <span className="block font-medium text-zinc-100">Voice conversation</span>
            Talk, pause, and the agent answers out loud. Speech stays on this computer.
          </>
        )
      }
    >
      <button
        type="button"
        aria-label={active ? "End voice conversation" : "Start voice conversation"}
        aria-pressed={active}
        disabled={disabled && !active}
        onClick={() => setConversation(active ? null : session.id)}
        className={cx(
          "flex size-7 items-center justify-center rounded-lg transition-colors disabled:opacity-40",
          active ? "bg-sky-500/15 text-sky-300" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
        )}
      >
        <AudioLines className="size-4" />
      </button>
    </Tooltip>
  );
}

/** Above the message box during a voice conversation: what is happening, and a way out. */
export function ConversationBar({ session }: { session: Session }) {
  const { status, conversation } = useVoice();
  if (conversation !== session.id) return null;
  const thinking = status.kind === "idle" && busy(session);
  const text =
    status.kind === "listening"
      ? "Listening…"
      : status.kind === "transcribing"
        ? "Transcribing…"
        : status.kind === "loading"
          ? `Downloading the speech model (${status.percent}%)…`
          : status.kind === "speaking"
            ? "Speaking… (click to skip)"
            : session.status === "waiting-approval"
              ? "Waiting for you…"
              : thinking
                ? "Thinking…"
                : "…";
  const bars = [0.55, 0.9, 1, 0.75, 0.5];
  return (
    <div className="animate-pop-in mb-2 flex items-center gap-3 rounded-xl border border-sky-500/25 bg-sky-500/5 px-3 py-2">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={() => {
          if (status.kind === "speaking") stopSpeaking();
          else if (status.kind === "listening" && isListening()) stopListening(true);
        }}
      >
        <span className="flex h-5 items-center gap-0.5" aria-hidden>
          {bars.map((b, i) => (
            <span
              key={i}
              className={cx("w-1 rounded-full bg-sky-300 transition-[height] duration-100", status.kind === "speaking" && "animate-pulse")}
              style={{
                height:
                  status.kind === "listening"
                    ? `${Math.max(3, status.level * b * 20)}px`
                    : status.kind === "speaking"
                      ? `${8 + b * 8}px`
                      : "3px",
              }}
            />
          ))}
        </span>
        <span className="truncate text-xs text-sky-200">{text}</span>
      </button>
      <button
        type="button"
        onClick={() => setConversation(null)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800"
      >
        <Square className="size-3 fill-current" /> End
      </button>
    </div>
  );
}

/** Reads one reply aloud; click again to stop. */
export function ReadAloudButton({ text }: { text: string }) {
  const { status } = useVoice();
  const [mine, setMine] = useState(false);
  const speaking = mine && status.kind === "speaking";
  useEffect(() => {
    if (mine && status.kind !== "speaking") setMine(false);
  }, [mine, status.kind]);
  return (
    <Tooltip content={speaking ? "Stop reading" : "Read aloud"}>
      <button
        type="button"
        aria-label={speaking ? "Stop reading" : "Read aloud"}
        onClick={() => {
          if (speaking) return stopSpeaking();
          stopSpeaking();
          setMine(true);
          speak(speakable(text));
        }}
        className={cx(
          "flex size-6 items-center justify-center rounded-md transition-all hover:bg-zinc-800",
          speaking ? "text-sky-300 opacity-100" : "text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-zinc-300",
        )}
      >
        {speaking ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
      </button>
    </Tooltip>
  );
}

const LANGUAGES = [
  ["", "Detect automatically"],
  ["english", "English"],
  ["french", "French"],
  ["spanish", "Spanish"],
  ["german", "German"],
  ["italian", "Italian"],
  ["portuguese", "Portuguese"],
  ["dutch", "Dutch"],
  ["japanese", "Japanese"],
  ["chinese", "Chinese"],
] as const;

/** Settings → Voice: speech model, language, voice and speed (stored on this device). */
export function VoiceSettings() {
  const { status, prefs } = useVoice();
  const [voices, setVoices] = useState(() => availableVoices());
  useEffect(() => {
    const update = () => setVoices(availableVoices());
    speechSynthesis.addEventListener("voiceschanged", update);
    return () => speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);
  const { ready, error } = modelState();
  const loaded = ready === prefs.model;
  const update = (patch: Partial<typeof prefs>) => savePrefs({ ...loadPrefs(), ...patch });
  const sorted = [...voices].sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));

  return (
    <FormSection
      title="Voice"
      description="Dictation and voice conversations. Speech is transcribed on this computer by Whisper; replies are read by your system's voices. Nothing leaves this machine."
    >
      <Field
        label="Speech model"
        hint={
          error
            ? `Could not load the model: ${error}`
            : status.kind === "loading"
              ? `Downloading… ${status.percent}%`
              : loaded
                ? "Loaded and ready."
                : "Downloads the first time you dictate, or now."
        }
      >
        <div className="flex gap-2">
          <select className={inputClass} value={prefs.model} onChange={(e) => update({ model: e.target.value })}>
            {SPEECH_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}: {m.detail}
              </option>
            ))}
          </select>
          {!loaded ? (
            <Button disabled={status.kind === "loading"} onClick={() => preloadModel(true)}>
              {status.kind === "loading" ? <Loader2 className="animate-spin" /> : null} Download
            </Button>
          ) : null}
        </div>
      </Field>
      <Field label="Language you speak" hint="Setting it avoids misdetections on short phrases.">
        <select className={inputClass} value={prefs.language ?? ""} onChange={(e) => update({ language: e.target.value || null })}>
          {LANGUAGES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Reading voice"
        hint="Enhanced and Premium voices sound much better: add them in System Settings → Accessibility → Spoken Content → System voice → Manage voices."
      >
        <div className="flex gap-2">
          <select className={inputClass} value={prefs.voice ?? ""} onChange={(e) => update({ voice: e.target.value || null })}>
            <option value="">Best available</option>
            {sorted.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
          <Button
            onClick={() => {
              stopSpeaking();
              speak("Hi! This is how I will sound when I read my replies to you.");
            }}
          >
            <Volume2 /> Test
          </Button>
        </div>
      </Field>
      <Field label={`Reading speed: ${prefs.rate.toFixed(2)}×`}>
        <input
          type="range"
          min={0.7}
          max={1.6}
          step={0.05}
          value={prefs.rate}
          onChange={(e) => update({ rate: Number(e.target.value) })}
          className="w-full accent-sky-400"
        />
      </Field>
    </FormSection>
  );
}

/** Settings → Notifications: a test that goes to this computer and every paired phone. */
export function NotificationSettings() {
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const test = () => {
    setBusy(true);
    setResult(null);
    fetch("/api/notifications/test", { method: "POST", credentials: "same-origin" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { phones?: number; error?: string };
        if (!response.ok) throw new Error(body.error ?? `failed (${response.status})`);
        const phones = body.phones ?? 0;
        setResult(
          `Sent to this computer${phones ? ` and ${phones} phone${phones > 1 ? "s" : ""}` : ". No phone is set up for notifications yet: open the Apollo app on it and allow them"}.`,
        );
      })
      .catch((e) => setResult(`Could not send: ${errorMessage(e)}`))
      .finally(() => setBusy(false));
  };
  return (
    <FormSection
      title="Notifications"
      description="Apollo notifies you when a turn finishes, or a bot needs an approval, an answer or a secret: here when its window is not in front, and on paired phones."
    >
      <div className="flex items-center gap-3">
        <Button onClick={test} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : null} Send a test notification
        </Button>
        {result ? <span className="text-[11px] leading-relaxed text-zinc-400">{result}</span> : null}
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Nothing shows on this Mac? Allow Apollo in System Settings → Notifications. The test shows even while this window is open.
      </p>
    </FormSection>
  );
}
