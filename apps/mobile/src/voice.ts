import * as Speech from "expo-speech";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { Platform } from "react-native";

/**
 * Voice on the phone: the system's speech recognition (on-device when the phone supports
 * it) to listen, and the system voices to read replies.
 */

export type VoiceStatus = { kind: "idle" } | { kind: "listening"; partial: string; level: number } | { kind: "speaking" };

let status: VoiceStatus = { kind: "idle" };
const listeners = new Set<(s: VoiceStatus) => void>();
const setStatus = (next: VoiceStatus) => {
  status = next;
  listeners.forEach((l) => l(next));
};
export const voiceStatus = () => status;
export const subscribeVoice = (listener: (s: VoiceStatus) => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

// ---------------------------------------------------------------------------------------
// Listening

let current: { finish: (keep: boolean) => void } | null = null;

/** The phone's language, e.g. "en-CA" or "fr-CA". */
const deviceLocale = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
};

/**
 * Listens until `stopListening()`, or (with `silenceMs`) until no new words arrive for
 * that long after the user started talking. Resolves with what was said ("" for nothing).
 */
export const listen = async ({ silenceMs }: { silenceMs: number | null }): Promise<string> => {
  current?.finish(false);
  await stopSpeaking();
  const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  if (!permission.granted) throw new Error("Allow the microphone and speech recognition for Apollo in Settings.");

  return new Promise<string>((resolve, reject) => {
    let text = "";
    let keep = true;
    let settled = false;
    let silence: ReturnType<typeof setTimeout> | null = null;
    const subscriptions = [
      ExpoSpeechRecognitionModule.addListener("result", (event) => {
        text = event.results[0]?.transcript ?? text;
        setStatus({ kind: "listening", partial: text, level: status.kind === "listening" ? status.level : 0 });
        if (silenceMs !== null && text.trim()) {
          if (silence) clearTimeout(silence);
          silence = setTimeout(() => ExpoSpeechRecognitionModule.stop(), silenceMs);
        }
      }),
      ExpoSpeechRecognitionModule.addListener("volumechange", (event) => {
        if (status.kind === "listening") setStatus({ ...status, level: Math.max(0, Math.min(1, event.value / 10)) });
      }),
      ExpoSpeechRecognitionModule.addListener("error", (event) => {
        // "no-speech" and "aborted" are normal endings: nothing was said, or we cancelled.
        if (event.error === "no-speech" || event.error === "aborted") return;
        done(new Error(event.message || event.error));
      }),
      ExpoSpeechRecognitionModule.addListener("end", () => done(null)),
    ];
    const done = (error: Error | null) => {
      if (settled) return;
      settled = true;
      if (silence) clearTimeout(silence);
      subscriptions.forEach((s) => s.remove());
      current = null;
      setStatus({ kind: "idle" });
      if (error) reject(error);
      else resolve(keep ? text.trim() : "");
    };
    current = {
      finish: (k) => {
        keep = k;
        if (k) ExpoSpeechRecognitionModule.stop();
        else ExpoSpeechRecognitionModule.abort();
      },
    };
    setStatus({ kind: "listening", partial: "", level: 0 });
    ExpoSpeechRecognitionModule.start({
      lang: deviceLocale(),
      interimResults: true,
      continuous: true,
      // Keep audio on the phone when it can transcribe by itself.
      requiresOnDeviceRecognition: ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(),
      addsPunctuation: true,
      iosTaskHint: "dictation",
      iosCategory: { category: "playAndRecord", categoryOptions: ["defaultToSpeaker", "allowBluetooth"], mode: "default" },
      volumeChangeEventOptions: { enabled: true, intervalMillis: 120 },
    });
  });
};

/** Ends listening: keeps what was said (`keep`), or throws it away. */
export const stopListening = (keep = true) => current?.finish(keep);
export const isListening = () => current !== null;

// ---------------------------------------------------------------------------------------
// Speaking

let queued = 0;
let drained: Array<() => void> = [];
const settle = () => {
  if (queued > 0) return;
  if (status.kind === "speaking") setStatus({ kind: "idle" });
  const waiting = drained;
  drained = [];
  waiting.forEach((r) => r());
};

/** Queues text to be read out through the speaker. */
export const speak = (text: string) => {
  const clean = text.trim();
  if (!clean) return;
  if (Platform.OS === "ios" && queued === 0) {
    // Recognition leaves the session in record mode; play replies loud, through the speaker.
    try {
      ExpoSpeechRecognitionModule.setCategoryIOS({ category: "playback", categoryOptions: ["duckOthers"], mode: "spokenAudio" });
    } catch {
      // Keep whatever session is active.
    }
  }
  queued++;
  setStatus({ kind: "speaking" });
  const done = () => {
    queued = Math.max(0, queued - 1);
    settle();
  };
  Speech.speak(clean, { rate: 1.02, onDone: done, onStopped: done, onError: done });
};

export const whenSpoken = () => (queued === 0 ? Promise.resolve() : new Promise<void>((r) => drained.push(r)));

export const stopSpeaking = async () => {
  if (queued === 0) return;
  await Speech.stop();
  queued = 0;
  settle();
};
