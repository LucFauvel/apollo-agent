/**
 * Reads the metadata at the start of a GGUF file: enough to estimate how much
 * memory a model's KV cache needs before downloading it.
 * Format: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 */

export type GgufValue = number | bigint | boolean | string | ReadonlyArray<number>;

export interface GgufHeader {
  readonly metadata: ReadonlyMap<string, GgufValue>;
  /** False when the buffer ended before all metadata was read. */
  readonly complete: boolean;
}

class Truncated extends Error {}

const FIXED_SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const STRING = 8;
const ARRAY = 9;
/** Numeric arrays up to this length are kept (per-layer head counts); longer ones are skipped. */
const MAX_KEPT_ARRAY = 4096;

export const parseGgufHeader = (buffer: Uint8Array): GgufHeader => {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const metadata = new Map<string, GgufValue>();
  let offset = 0;

  const need = (bytes: number) => {
    if (offset + bytes > buffer.byteLength) throw new Truncated();
  };
  const u32 = () => {
    need(4);
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const u64 = () => {
    need(8);
    const value = view.getBigUint64(offset, true);
    offset += 8;
    return Number(value);
  };
  const string = () => {
    const length = u64();
    need(length);
    const value = new TextDecoder().decode(buffer.subarray(offset, offset + length));
    offset += length;
    return value;
  };
  const scalar = (type: number): number | bigint | boolean => {
    const size = FIXED_SIZES[type];
    if (size === undefined) throw new Error(`unknown GGUF value type ${type}`);
    need(size);
    const at = offset;
    offset += size;
    switch (type) {
      case 0: return view.getUint8(at);
      case 1: return view.getInt8(at);
      case 2: return view.getUint16(at, true);
      case 3: return view.getInt16(at, true);
      case 4: return view.getUint32(at, true);
      case 5: return view.getInt32(at, true);
      case 6: return view.getFloat32(at, true);
      case 7: return view.getUint8(at) !== 0;
      case 10: return view.getBigUint64(at, true);
      case 11: return view.getBigInt64(at, true);
      default: return view.getFloat64(at, true);
    }
  };
  const value = (type: number): GgufValue | undefined => {
    if (type === STRING) return string();
    if (type !== ARRAY) return scalar(type);
    const elementType = u32();
    const count = u64();
    if (elementType === STRING) {
      for (let i = 0; i < count; i++) string();
      return undefined;
    }
    const size = FIXED_SIZES[elementType];
    if (size === undefined) throw new Error(`unknown GGUF array type ${elementType}`);
    if (count > MAX_KEPT_ARRAY) {
      need(size * count);
      offset += size * count;
      return undefined;
    }
    return Array.from({ length: count }, () => Number(scalar(elementType)));
  };

  try {
    need(4);
    if (new TextDecoder().decode(buffer.subarray(0, 4)) !== "GGUF") throw new Error("not a GGUF file");
    offset = 4;
    u32(); // version
    u64(); // tensor count
    const count = u64();
    for (let i = 0; i < count; i++) {
      const key = string();
      const result = value(u32());
      if (result !== undefined) metadata.set(key, result);
    }
    return { metadata, complete: true };
  } catch (error) {
    if (error instanceof Truncated) return { metadata, complete: false };
    throw error;
  }
};

const num = (value: GgufValue | undefined): number | null =>
  typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;

/** What the memory estimate needs from a model's metadata. */
export interface ModelShape {
  readonly architecture: string;
  readonly contextLength: number | null;
  /** KV cache bytes per token of context with an 8-bit (q8_0) cache. */
  readonly kvBytesPerToken: number;
}

/** Keys the estimate reads; parsing can stop once they are all present. */
export const shapeKeys = (architecture: string) => [
  `${architecture}.block_count`,
  `${architecture}.attention.head_count`,
];

/** q8_0 stores 32 values in 34 bytes. */
const Q8_0_BYTES = 34 / 32;

/**
 * Estimates the KV cache per token from the attention layout. Handles per-layer
 * head counts (layers with 0 KV heads have none) and hybrid models that only put
 * full attention every Nth layer. Sliding-window layers are counted as full,
 * which overestimates for those models.
 */
export const modelShape = (metadata: ReadonlyMap<string, GgufValue>): ModelShape | null => {
  const architecture = metadata.get("general.architecture");
  if (typeof architecture !== "string") return null;
  const key = (name: string) => metadata.get(`${architecture}.${name}`);
  const layers = num(key("block_count"));
  const embedding = num(key("embedding_length"));
  const heads = key("attention.head_count");
  const kvHeads = key("attention.head_count_kv") ?? heads;
  if (layers === null || kvHeads === undefined) return null;

  const firstHeads = Array.isArray(heads) ? (heads.find((h) => h > 0) ?? 0) : (num(heads) ?? 0);
  const keyLength = num(key("attention.key_length")) ?? (embedding && firstHeads ? embedding / firstHeads : null);
  const valueLength = num(key("attention.value_length")) ?? keyLength;
  if (keyLength === null || valueLength === null) return null;

  let kvElements: number;
  if (Array.isArray(kvHeads)) {
    kvElements = kvHeads.reduce((sum, n) => sum + n * (keyLength + valueLength), 0);
  } else {
    const interval = num(key("full_attention_interval"));
    const attentionLayers = interval && interval > 1 ? Math.ceil(layers / interval) : layers;
    kvElements = attentionLayers * (num(kvHeads) ?? 0) * (keyLength + valueLength);
  }
  return {
    architecture,
    contextLength: num(key("context_length")),
    kvBytesPerToken: Math.ceil(kvElements * Q8_0_BYTES),
  };
};
