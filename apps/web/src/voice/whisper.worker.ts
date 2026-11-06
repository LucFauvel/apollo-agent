/// <reference lib="webworker" />
import { type AutomaticSpeechRecognitionPipeline, pipeline } from "@huggingface/transformers";

/**
 * Whisper, running locally in a worker (WebGPU when the machine has it, WASM otherwise).
 * The model downloads from Hugging Face once and is cached by the browser after that.
 */

export type WorkerRequest =
  | { type: "load"; model: string }
  | { type: "transcribe"; id: number; model: string; audio: Float32Array; language: string | null };

export type WorkerResponse =
  | { type: "progress"; model: string; percent: number; loaded: number; total: number }
  | { type: "ready"; model: string; device: "webgpu" | "wasm" }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id: number | null; message: string };

const post = (message: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);

let loaded: { model: string; asr: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

const hasWebGpu = async () => {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    return gpu !== undefined && (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
};

const load = (model: string) => {
  if (loaded?.model === model) return loaded.asr;
  const asr = (async () => {
    const webgpu = await hasWebGpu();
    const progress_callback = (info: { status: string; progress?: number; loaded?: number; total?: number }) => {
      if (info.status === "progress_total") {
        post({ type: "progress", model, percent: Math.round(info.progress ?? 0), loaded: info.loaded ?? 0, total: info.total ?? 0 });
      }
    };
    const options = webgpu
      ? // The encoder needs full precision on GPU; a 4-bit decoder keeps it small and fast.
        { device: "webgpu" as const, dtype: { encoder_model: "fp32" as const, decoder_model_merged: "q4" as const }, progress_callback }
      : { device: "wasm" as const, dtype: "q8" as const, progress_callback };
    const result = (await pipeline("automatic-speech-recognition", model, options)) as AutomaticSpeechRecognitionPipeline;
    post({ type: "ready", model, device: webgpu ? "webgpu" : "wasm" });
    return result;
  })();
  loaded = { model, asr };
  asr.catch(() => {
    if (loaded?.asr === asr) loaded = null;
  });
  return asr;
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "load") {
      await load(request.model);
      return;
    }
    const asr = await load(request.model);
    const output = await asr(request.audio, {
      ...(request.language ? { language: request.language } : {}),
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = (Array.isArray(output) ? output.map((o) => o.text).join(" ") : output.text).trim();
    post({ type: "result", id: request.id, text });
  } catch (error) {
    post({ type: "error", id: request.type === "transcribe" ? request.id : null, message: error instanceof Error ? error.message : String(error) });
  }
};
