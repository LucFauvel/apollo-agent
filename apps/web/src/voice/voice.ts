import type { WorkerRequest, WorkerResponse } from "./whisper.worker.ts";

/**
 * Voice for the desktop app: local Whisper to dictate, the system's voices to read.
 * Everything runs on this machine; only the speech model downloads, once.
 */

// ---------------------------------------------------------------------------------------
// Preferences (per device)

export const SPEECH_MODELS = [
  { id: "onnx-community/whisper-base", label: "Fast", detail: "About 80 MB. Quick, fine for clear speech." },
  { id: "onnx-community/whisper-small", label: "Balanced", detail: "About 250 MB. Better with accents and other languages." },
  { id: "onnx-community/whisper-large-v3-turbo", label: "Best", detail: "About 800 MB. Most accurate; needs a recent Mac." },
] as const;

export interface VoicePrefs {
  /** Hugging Face id of the Whisper model. */
  readonly model: string;
  /** Language spoken, as Whisper names it ("english", "french"…), or null to detect. */
  readonly language: string | null;
  /** System voice name, or null for the best one available. */
  readonly voice: string | null;
  readonly rate: number;
}

const PREFS_KEY = "apollo.voice";
const DEFAULT_PREFS: VoicePrefs = { model: SPEECH_MODELS[1].id, language: null, voice: null, rate: 1.05 };

export const loadPrefs = (): VoicePrefs => {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
};

export const savePrefs = (prefs: VoicePrefs) => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or storage off: the defaults apply next time.
  }
  emit();
};

// ---------------------------------------------------------------------------------------
// State shared by the composer, the transcript and settings

export type VoiceStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly percent: number }
  | { readonly kind: "listening"; readonly level: number }
  | { readonly kind: "transcribing" }
  | { readonly kind: "speaking" };

let status: VoiceStatus = { kind: "idle" };
/** The session in voice conversation mode, if any. */
let conversation: string | null = null;
const listeners = new Set<() => void>();
/** A stable object between changes, for useSyncExternalStore. */
let snapshot: { readonly status: VoiceStatus; readonly conversation: string | null; readonly prefs: VoicePrefs } | null = null;
const emit = () => {
  snapshot = null;
  listeners.forEach((l) => l());
};
const setStatus = (next: VoiceStatus) => {
  status = next;
  emit();
};

export const voiceState = () => (snapshot ??= { status, conversation, prefs: loadPrefs() });
export const subscribeVoice = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const setConversation = (sessionId: string | null) => {
  conversation = sessionId;
  if (sessionId === null) {
    stopListening(false);
    stopSpeaking();
  }
  emit();
};

// ---------------------------------------------------------------------------------------
// Transcription (Whisper in a worker)

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
let modelReady: string | null = null;

const ensureWorker = () => {
  if (worker) return worker;
  worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (message.type === "progress") {
      if (status.kind === "loading" || status.kind === "transcribing") setStatus({ kind: "loading", percent: message.percent });
    } else if (message.type === "ready") {
      modelReady = message.model;
      if (status.kind === "loading") setStatus(pending.size > 0 ? { kind: "transcribing" } : { kind: "idle" });
      else emit();
    } else if (message.type === "result") {
      pending.get(message.id)?.resolve(message.text);
      pending.delete(message.id);
    } else if (message.id !== null) {
      pending.get(message.id)?.reject(new Error(message.message));
      pending.delete(message.id);
    } else {
      loadError = message.message;
      if (status.kind === "loading") setStatus({ kind: "idle" });
      else emit();
    }
  };
  return worker;
};

let loadError: string | null = null;
/** Which speech model is loaded, and why the last load failed. */
export const modelState = () => ({ ready: modelReady, error: loadError });

/** Downloads and loads the speech model ahead of time (settings, or the first mic press). */
export const preloadModel = (show = false) => {
  const { model } = loadPrefs();
  if (modelReady === model) return;
  loadError = null;
  if (show && status.kind === "idle") setStatus({ kind: "loading", percent: 0 });
  ensureWorker().postMessage({ type: "load", model } satisfies WorkerRequest);
};

const transcribe = (audio: Float32Array): Promise<string> => {
  const { model, language } = loadPrefs();
  const id = ++nextId;
  setStatus(modelReady === model ? { kind: "transcribing" } : { kind: "loading", percent: 0 });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ type: "transcribe", id, model, audio, language } satisfies WorkerRequest, [audio.buffer]);
  });
};

// ---------------------------------------------------------------------------------------
// Microphone, with silence detection to end an utterance

const SAMPLE_RATE = 16_000;
let recording: { stop: (keep: boolean) => void } | null = null;

export const isListening = () => recording !== null;

/**
 * Records until `stopListening()`, or (with `untilSilence`) until the speaker pauses
 * after saying something. Resolves with the transcript; "" when nothing was said.
 */
export const listen = async ({ untilSilence }: { untilSilence: boolean }): Promise<string> => {
  if (recording) recording.stop(false);
  stopSpeaking();
  preloadModel();
  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .catch((error: DOMException) => {
      throw new Error(
        error.name === "NotAllowedError"
          ? "Apollo can't use the microphone. Allow it in System Settings → Privacy & Security → Microphone."
          : error.name === "NotFoundError"
            ? "No microphone found."
            : `Microphone unavailable: ${error.message}`,
      );
    });
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but universally available and plenty for 16 kHz mono.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks: Array<Float32Array> = [];
  setStatus({ kind: "listening", level: 0 });

  return new Promise<string>((resolve, reject) => {
    let noise = 0.01;
    let heard = false;
    let silentFor = 0;
    let elapsed = 0;
    const startedAt = performance.now();

    const finish = (keep: boolean) => {
      recording = null;
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
      const length = chunks.reduce((n, c) => n + c.length, 0);
      if (!keep || !heard || length < SAMPLE_RATE * 0.3) {
        setStatus({ kind: "idle" });
        resolve("");
        return;
      }
      const audio = new Float32Array(length);
      let offset = 0;
      for (const c of chunks) {
        audio.set(c, offset);
        offset += c.length;
      }
      transcribe(audio)
        .then((text) => {
          setStatus({ kind: "idle" });
          // Whisper's guesses for silence or noise.
          resolve(/^\s*(\[.*\]|\(.*\)|you\.?|thank you\.?)\s*$/i.test(text) ? "" : text);
        })
        .catch((error) => {
          setStatus({ kind: "idle" });
          reject(error);
        });
    };
    recording = { stop: finish };

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input));
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!;
      const rms = Math.sqrt(sum / input.length);
      const seconds = input.length / SAMPLE_RATE;
      elapsed += seconds;
      // Learn the room's noise in the first half second, then look for speech above it.
      if (elapsed < 0.5) noise = Math.max(noise, rms * 1.5);
      const speaking = rms > Math.max(noise * 2.2, 0.015);
      if (speaking) {
        heard = heard || elapsed > 0.15;
        silentFor = 0;
      } else silentFor += seconds;
      setStatus({ kind: "listening", level: Math.min(1, rms / 0.15) });
      if (untilSilence && heard && silentFor > 1.2) finish(true);
      else if (performance.now() - startedAt > 120_000) finish(true);
    };
    source.connect(processor);
    processor.connect(context.destination);
  });
};

/** Ends the recording: transcribes what was said (`keep`), or throws it away. */
export const stopListening = (keep = true) => recording?.stop(keep);

// ---------------------------------------------------------------------------------------
// Reading aloud (system voices)

/** The best voice for a language: the user's pick, else premium/enhanced ones first. */
const pickVoice = (): SpeechSynthesisVoice | null => {
  const voices = speechSynthesis.getVoices();
  const { voice } = loadPrefs();
  const chosen = voice ? voices.find((v) => v.name === voice) : undefined;
  if (chosen) return chosen;
  const lang = navigator.language.slice(0, 2);
  const local = voices.filter((v) => v.lang.startsWith(lang));
  const quality = (v: SpeechSynthesisVoice) => (/premium/i.test(v.name) ? 3 : /enhanced|natural|neural/i.test(v.name) ? 2 : v.localService ? 1 : 0);
  return [...local].sort((a, b) => quality(b) - quality(a))[0] ?? voices.find((v) => v.default) ?? null;
};

export const availableVoices = () => speechSynthesis.getVoices();

let queued = 0;
/** Resolves when everything queued so far has been said (or speech was stopped). */
let drained: Array<() => void> = [];
const settle = () => {
  if (queued > 0) return;
  if (status.kind === "speaking") setStatus({ kind: "idle" });
  const waiting = drained;
  drained = [];
  waiting.forEach((r) => r());
};

/** Queues text to be read out. */
export const speak = (text: string) => {
  const clean = text.trim();
  if (!clean) return;
  const utterance = new SpeechSynthesisUtterance(clean);
  const voice = pickVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  utterance.rate = loadPrefs().rate;
  queued++;
  const done = () => {
    queued = Math.max(0, queued - 1);
    settle();
  };
  utterance.onend = done;
  utterance.onerror = done;
  setStatus({ kind: "speaking" });
  speechSynthesis.speak(utterance);
};

export const isSpeaking = () => queued > 0;
export const whenSpoken = () => (queued === 0 ? Promise.resolve() : new Promise<void>((r) => drained.push(r)));

export const stopSpeaking = () => {
  speechSynthesis.cancel();
  queued = 0;
  settle();
};
