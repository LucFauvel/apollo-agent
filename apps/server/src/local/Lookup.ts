import type { Hardware, ModelCandidate, ModelDetails, ModelFit, QuantOption, SuggestedModel } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import { type ModelShape, modelShape, parseGgufHeader } from "./Gguf.ts";

const HF = "https://huggingface.co";
const GIB = 1024 ** 3;

/** Context window every estimate assumes: what Claude Code's tools need to be useful. */
export const TARGET_CONTEXT = 65_536;
/** llama-server's own buffers on top of weights and KV cache (`--fit` keeps 1 GiB free too). */
const RUNTIME_OVERHEAD = 0.6 * GIB;
const FIT_MARGIN = 1 * GIB;
/** Share of system RAM a model may spill into. */
const RAM_SHARE = 0.6;
/** Below 4 bits per weight quality drops too far; never suggest those. */
const MIN_BITS = 4;
/** Publishers whose GGUF conversions are reliable, most trusted first. */
export const TRUSTED_AUTHORS = ["ggml-org", "unsloth", "bartowski", "lmstudio-community"] as const;

const fetchJson = async <A>(url: string, signal: AbortSignal): Promise<A> => {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: { "user-agent": "apollo-desktop" },
  });
  if (!response.ok) throw new Error(`Hugging Face answered ${response.status} for ${url}`);
  return (await response.json()) as A;
};

const lookupError = (cause: unknown) =>
  new Error(`Hugging Face lookup failed: ${cause instanceof Error ? cause.message : String(cause)}`);

// ---------------------------------------------------------------------------
// Quantizations
// ---------------------------------------------------------------------------

/** Files that ship next to a model but are not one (projectors, draft heads, imatrix). */
const SIDECAR = /mmproj|mtp|dflash|eagle|dspark|draft|assistant|imatrix/i;
const QUANT = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|TQ\d_\d|MXFP4(?:_MOE)?|BF16|F16|F32))(?:-\d{5}-of-\d{5})?\.gguf$/i;

/** Approximate bits per weight, by quant family. */
export const bitsOf = (quant: string): number => {
  const q = quant.toUpperCase().replace(/^UD-/, "");
  if (q === "F32") return 32;
  if (q === "F16" || q === "BF16") return 16;
  if (q.startsWith("MXFP4")) return 4.25;
  const digit = Number(/(\d)/.exec(q)?.[1] ?? 4);
  const table: Record<number, number> = { 1: 1.75, 2: 2.6, 3: 3.5, 4: 4.6, 5: 5.5, 6: 6.6, 8: 8.5 };
  return table[digit] ?? digit;
};

export interface QuantFiles {
  readonly quant: string;
  readonly sizeBytes: number;
  /** The first file (or shard), whose header describes the model. */
  readonly firstFile: string;
}

/** Groups a repository's GGUF files into quantizations (shards summed). */
export const groupQuants = (files: ReadonlyArray<{ path: string; size: number }>): Array<QuantFiles> => {
  const groups = new Map<string, { quant: string; sizeBytes: number; files: Array<string> }>();
  for (const file of files) {
    const name = file.path.split("/").pop()!;
    if (!name.endsWith(".gguf") || SIDECAR.test(name)) continue;
    const quant = QUANT.exec(name)?.[1];
    if (!quant) continue;
    const key = quant.toUpperCase();
    const group = groups.get(key) ?? { quant, sizeBytes: 0, files: [] };
    group.sizeBytes += file.size;
    group.files.push(file.path);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((g) => ({ quant: g.quant, sizeBytes: g.sizeBytes, firstFile: g.files.sort()[0]! }))
    .sort((a, b) => a.sizeBytes - b.sizeBytes);
};

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

/** Memory the GPU(s) can give a model, and what may spill into RAM. */
export const memoryBudget = (hardware: Hardware) => {
  const unified = hardware.gpus.find((g) => g.unified);
  if (unified) return { gpu: Math.max(unified.memoryBytes - FIT_MARGIN, 0), ram: 0 };
  // Free memory when known: the desktop and other apps hold some of it.
  const dedicated = hardware.gpus.filter((g) => !g.unified).reduce((sum, g) => sum + (g.freeBytes ?? g.memoryBytes), 0);
  return { gpu: Math.max(dedicated - FIT_MARGIN, 0), ram: hardware.ramBytes * RAM_SHARE };
};

export const contextFor = (shape: ModelShape | null) =>
  Math.min(TARGET_CONTEXT, shape?.contextLength ?? TARGET_CONTEXT);

/** Weights + KV cache at the target context + runtime buffers. */
export const memoryNeeded = (sizeBytes: number, shape: ModelShape | null) => {
  // Without a shape, assume the KV cache is a quarter of the weights (typical at 64K).
  const kv = shape ? shape.kvBytesPerToken * contextFor(shape) : sizeBytes * 0.25;
  return sizeBytes + kv + RUNTIME_OVERHEAD;
};

export const fitOf = (needed: number, budget: { gpu: number; ram: number }): ModelFit =>
  needed <= budget.gpu ? "gpu" : needed <= budget.gpu + budget.ram ? "ram" : "too-big";

/**
 * The quant to suggest: the highest quality (largest, up to 8-bit) that runs
 * fully on the GPU; else the most compact 4-bit+ one that works with system RAM.
 */
export const pickQuant = (quants: ReadonlyArray<QuantOption>): QuantOption | null => {
  const usable = quants.filter((q) => q.bits >= MIN_BITS && q.bits <= 8.5);
  const onGpu = usable.filter((q) => q.fit === "gpu").sort((a, b) => b.sizeBytes - a.sizeBytes);
  if (onGpu[0]) return onGpu[0];
  return usable.filter((q) => q.fit === "ram").sort((a, b) => a.sizeBytes - b.sizeBytes)[0] ?? null;
};

// ---------------------------------------------------------------------------
// Hugging Face
// ---------------------------------------------------------------------------

interface HfModel {
  id: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  tags?: Array<string>;
  gguf?: { total?: number; context_length?: number; architecture?: string };
}

const EXPAND = ["gguf", "downloads", "likes", "pipeline_tag", "tags"].map((e) => `expand[]=${e}`).join("&");

/** Display name: `unsloth/Qwen3-4B-Instruct-2507-GGUF` → `Qwen3-4B-Instruct-2507`. */
export const displayName = (repo: string) =>
  repo
    .split("/")
    .pop()!
    .replace(/[-_.]?GGUF$/i, "");

const toCandidate = (m: HfModel): ModelCandidate => ({
  repo: m.id,
  name: displayName(m.id),
  author: m.id.split("/")[0]!,
  downloads: m.downloads ?? 0,
  likes: m.likes ?? 0,
  parameters: m.gguf?.total ?? null,
  contextLength: m.gguf?.context_length ?? null,
  vision: m.pipeline_tag === "image-text-to-text" || (m.tags ?? []).includes("vision"),
});

/** Chat models only: no embedding, reranking or speech repositories. */
const isChatModel = (m: HfModel) =>
  !/embed|rerank|whisper|tts|ocr|guard/i.test(m.id) &&
  (m.pipeline_tag === undefined ||
    m.pipeline_tag === "text-generation" ||
    m.pipeline_tag === "image-text-to-text" ||
    (m.tags ?? []).includes("conversational"));

export const searchModels = (query: string) =>
  Effect.tryPromise({
    try: (signal) =>
      fetchJson<Array<HfModel>>(
        `${HF}/api/models?apps=llama.cpp&search=${encodeURIComponent(query)}&sort=downloads&limit=30&${EXPAND}`,
        signal,
      ),
    catch: lookupError,
  }).pipe(Effect.map((models) => models.filter(isChatModel).map(toCandidate)));

const fetchCandidate = (repo: string, signal: AbortSignal) =>
  fetchJson<HfModel>(`${HF}/api/models/${repo}?${EXPAND}`, signal).then(toCandidate);

/** Reads the model's attention layout from the start of one of its files. */
const fetchShape = async (repo: string, file: string, signal: AbortSignal): Promise<ModelShape | null> => {
  for (const bytes of [2, 8].map((mib) => mib * 1024 * 1024)) {
    const response = await fetch(`${HF}/${repo}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { range: `bytes=0-${bytes - 1}`, "user-agent": "apollo-desktop" },
    });
    if (!response.ok) return null;
    const header = parseGgufHeader(new Uint8Array(await response.arrayBuffer()));
    const shape = modelShape(header.metadata);
    if (shape || header.complete) return shape;
  }
  return null;
};

/** Every quantization of a repository, sized for this machine. */
export const modelDetails = (repo: string, hardware: Hardware, known?: ModelCandidate) =>
  Effect.tryPromise({
    try: async (signal): Promise<ModelDetails> => {
      const [candidate, files] = await Promise.all([
        known ?? fetchCandidate(repo, signal),
        fetchJson<Array<{ type: string; path: string; size: number }>>(
          `${HF}/api/models/${repo}/tree/main?recursive=true`,
          signal,
        ),
      ]);
      const quants = groupQuants(files.filter((f) => f.type === "file"));
      // Every quant shares the layout; the smallest file is the cheapest to read.
      const shape = quants[0] ? await fetchShape(repo, quants[0].firstFile, signal).catch(() => null) : null;
      const budget = memoryBudget(hardware);
      const options: Array<QuantOption> = quants.map((q) => {
        const memoryBytes = memoryNeeded(q.sizeBytes, shape);
        return { quant: q.quant, sizeBytes: q.sizeBytes, bits: bitsOf(q.quant), memoryBytes, fit: fitOf(memoryBytes, budget) };
      });
      const best = pickQuant(options);
      const note =
        quants.length === 0
          ? "This repository has no GGUF model files Apollo can use."
          : !best
            ? options.some((q) => q.bits >= MIN_BITS)
              ? "No 4-bit or better build fits this machine."
              : "Only builds below 4 bits per weight exist; their quality is too poor to suggest."
            : !shape
              ? "Memory estimates are rough: the model's attention layout could not be read."
              : null;
      return { candidate, contextSize: contextFor(shape), quants: options, bestQuant: best?.quant ?? null, note };
    },
    catch: lookupError,
  });

/**
 * Popular models from trusted publishers, sized for this machine. The
 * recommendation is the largest model whose best build runs fully on the GPU.
 */
export const suggestModels = (hardware: Hardware) =>
  Effect.gen(function* () {
    const budget = memoryBudget(hardware);
    const lists = yield* Effect.forEach(
      TRUSTED_AUTHORS,
      (author) =>
        Effect.tryPromise({
          try: (signal) =>
            fetchJson<Array<HfModel>>(
              `${HF}/api/models?apps=llama.cpp&author=${author}&sort=downloads&limit=25&${EXPAND}`,
              signal,
            ),
          catch: lookupError,
        }).pipe(Effect.orElseSucceed(() => [] as Array<HfModel>)),
      { concurrency: TRUSTED_AUTHORS.length },
    );
    // One entry per model, from the most trusted publisher that has it.
    const seen = new Set<string>();
    const candidates: Array<ModelCandidate> = [];
    for (const model of lists.flat()) {
      if (!isChatModel(model) || /abliterat|uncensor/i.test(model.id)) continue;
      const key = displayName(model.id).toLowerCase().replace(/^[a-z0-9]+_/, "");
      if (seen.has(key)) continue;
      // Skip what cannot fit even at 4 bits (about 0.55 bytes per parameter).
      const params = model.gguf?.total;
      if (params && params * 0.55 > budget.gpu + budget.ram) continue;
      seen.add(key);
      candidates.push(toCandidate(model));
    }
    const top = candidates.sort((a, b) => b.downloads - a.downloads).slice(0, 12);
    const details = yield* Effect.forEach(
      top,
      (candidate) => modelDetails(candidate.repo, hardware, candidate).pipe(Effect.option),
      { concurrency: 4 },
    );
    const sized = details.flatMap((d) => (d._tag === "Some" ? [d.value] : []));
    const fitRank = (d: ModelDetails) => {
      const fit = d.quants.find((q) => q.quant === d.bestQuant)?.fit;
      return fit === "gpu" ? 0 : fit === "ram" ? 1 : 2;
    };
    const recommended = sized
      .filter((d) => fitRank(d) === 0)
      .sort((a, b) => (b.candidate.parameters ?? 0) - (a.candidate.parameters ?? 0))[0];
    return sized
      .map((details): SuggestedModel => ({ details, recommended: details === recommended }))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended) || fitRank(a.details) - fitRank(b.details));
  });
