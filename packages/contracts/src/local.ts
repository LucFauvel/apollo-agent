import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Local models: the llama.cpp engine, the server Apollo runs, and model lookup
// ---------------------------------------------------------------------------

/** llama.cpp builds Apollo can install. `auto` picks one for the hardware. */
export const LlamaBackend = Schema.Literals(["auto", "cuda", "vulkan", "rocm", "metal", "cpu"]);
export type LlamaBackend = typeof LlamaBackend.Type;

export const Gpu = Schema.Struct({
  name: Schema.String,
  vendor: Schema.Literals(["nvidia", "amd", "intel", "apple", "other"]),
  memoryBytes: Schema.Number,
  freeBytes: Schema.NullOr(Schema.Number),
  /** Shares system RAM (Apple silicon, integrated GPUs). */
  unified: Schema.Boolean,
});
export type Gpu = typeof Gpu.Type;

export const Hardware = Schema.Struct({
  platform: Schema.String,
  arch: Schema.String,
  ramBytes: Schema.Number,
  gpus: Schema.Array(Gpu),
  /** Highest CUDA version the NVIDIA driver supports, e.g. "13.4". */
  cudaVersion: Schema.NullOr(Schema.String),
});
export type Hardware = typeof Hardware.Type;

/** Bytes done of a total (0 when unknown yet). */
export const Progress = Schema.Struct({ done: Schema.Number, total: Schema.Number });
export type Progress = typeof Progress.Type;

export const EngineState = Schema.Struct({
  installed: Schema.NullOr(
    Schema.Struct({ tag: Schema.String, backend: LlamaBackend, installedAt: Schema.Number }),
  ),
  /** Newest llama.cpp release with a build for this machine, once checked. */
  latestTag: Schema.NullOr(Schema.String),
  /** The backend `auto` resolves to here. */
  recommendedBackend: LlamaBackend,
  installing: Schema.NullOr(Schema.Struct({ backend: LlamaBackend, step: Schema.String, progress: Progress })),
  error: Schema.NullOr(Schema.String),
});
export type EngineState = typeof EngineState.Type;

export const ServerStatus = Schema.Literals(["stopped", "starting", "running", "error"]);
export type ServerStatus = typeof ServerStatus.Type;

export const LocalModelStatus = Schema.Literals(["unloaded", "loading", "loaded", "sleeping", "downloading", "failed"]);
export type LocalModelStatus = typeof LocalModelStatus.Type;

/** A model in Apollo's library, as llama-server reports it. */
export const LocalModel = Schema.Struct({
  /** `<repo>:<quant>`, the name sessions use. */
  id: Schema.String,
  status: LocalModelStatus,
  sizeBytes: Schema.NullOr(Schema.Number),
  download: Schema.NullOr(Progress),
  /** Context window it loads with (measured by llama-server). */
  contextSize: Schema.NullOr(Schema.Number),
  /** Whether that fits in GPU memory, as llama-server measured it. */
  fit: Schema.NullOr(Schema.Literals(["gpu", "ram"])),
});
export type LocalModel = typeof LocalModel.Type;

export const LocalModelsState = Schema.Struct({
  hardware: Hardware,
  engine: EngineState,
  server: Schema.Struct({ status: ServerStatus, error: Schema.NullOr(Schema.String) }),
  models: Schema.Array(LocalModel),
  defaultModel: Schema.NullOr(Schema.String),
});
export type LocalModelsState = typeof LocalModelsState.Type;

/**
 * How a model build runs here: entirely in GPU (or unified) memory, partly in
 * system RAM (works, slower), or not at all.
 */
export const ModelFit = Schema.Literals(["gpu", "ram", "too-big"]);
export type ModelFit = typeof ModelFit.Type;

/** One quantization of a model repository. */
export const QuantOption = Schema.Struct({
  quant: Schema.String,
  sizeBytes: Schema.Number,
  /** Approximate bits per weight. */
  bits: Schema.Number,
  /** Model + KV cache + buffers at `contextSize`. */
  memoryBytes: Schema.Number,
  fit: ModelFit,
});
export type QuantOption = typeof QuantOption.Type;

/** A GGUF repository on Hugging Face. */
export const ModelCandidate = Schema.Struct({
  repo: Schema.String,
  name: Schema.String,
  author: Schema.String,
  downloads: Schema.Number,
  likes: Schema.Number,
  parameters: Schema.NullOr(Schema.Number),
  contextLength: Schema.NullOr(Schema.Number),
  vision: Schema.Boolean,
});
export type ModelCandidate = typeof ModelCandidate.Type;

export const ModelDetails = Schema.Struct({
  candidate: ModelCandidate,
  /** Context window the memory estimates assume. */
  contextSize: Schema.Number,
  quants: Schema.Array(QuantOption),
  /** Best quality that fits, never below 4-bit. */
  bestQuant: Schema.NullOr(Schema.String),
  /** Why no quant was picked, or why estimates are rough. */
  note: Schema.NullOr(Schema.String),
});
export type ModelDetails = typeof ModelDetails.Type;

export const SuggestedModel = Schema.Struct({
  details: ModelDetails,
  recommended: Schema.Boolean,
});
export type SuggestedModel = typeof SuggestedModel.Type;
