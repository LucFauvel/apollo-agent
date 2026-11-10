/**
 * BLAKE2b-512 (RFC 7693), unkeyed, in plain TypeScript: minisign signs the BLAKE2b-512 hash of
 * the file, and Electron's Node is built on BoringSSL, which has no `blake2b512` digest
 * (checked on Electron 44.10.1: `crypto.getHashes()` lacks it and createHash throws "Digest
 * method not supported"). Only ever run over the small release manifest, so BigInt arithmetic
 * is fast enough and keeps this short. Tested against Node's own blake2b512 and RFC 7693's vector.
 */

const MASK = (1n << 64n) - 1n;

const IV: ReadonlyArray<bigint> = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK;

const compress = (h: Array<bigint>, block: Uint8Array, counter: bigint, last: boolean) => {
  const view = new DataView(block.buffer, block.byteOffset, 128);
  const m = Array.from({ length: 16 }, (_, i) => view.getBigUint64(i * 8, true));
  const v = [...h, ...IV];
  v[12] = v[12]! ^ (counter & MASK);
  v[13] = v[13]! ^ (counter >> 64n);
  if (last) v[14] = v[14]! ^ MASK;
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = (v[a]! + v[b]! + x) & MASK;
    v[d] = rotr(v[d]! ^ v[a]!, 32n);
    v[c] = (v[c]! + v[d]!) & MASK;
    v[b] = rotr(v[b]! ^ v[c]!, 24n);
    v[a] = (v[a]! + v[b]! + y) & MASK;
    v[d] = rotr(v[d]! ^ v[a]!, 16n);
    v[c] = (v[c]! + v[d]!) & MASK;
    v[b] = rotr(v[b]! ^ v[c]!, 63n);
  };
  for (let round = 0; round < 12; round++) {
    const s = SIGMA[round % 10]!;
    g(0, 4, 8, 12, m[s[0]!]!, m[s[1]!]!);
    g(1, 5, 9, 13, m[s[2]!]!, m[s[3]!]!);
    g(2, 6, 10, 14, m[s[4]!]!, m[s[5]!]!);
    g(3, 7, 11, 15, m[s[6]!]!, m[s[7]!]!);
    g(0, 5, 10, 15, m[s[8]!]!, m[s[9]!]!);
    g(1, 6, 11, 12, m[s[10]!]!, m[s[11]!]!);
    g(2, 7, 8, 13, m[s[12]!]!, m[s[13]!]!);
    g(3, 4, 9, 14, m[s[14]!]!, m[s[15]!]!);
  }
  for (let i = 0; i < 8; i++) h[i] = h[i]! ^ v[i]! ^ v[i + 8]!;
};

/** The 64-byte BLAKE2b-512 digest of `data`. */
export const blake2b512 = (data: Uint8Array): Uint8Array => {
  const h = [...IV];
  // Parameter block: digest length 64, no key, fanout 1, depth 1.
  h[0] = h[0]! ^ 0x01010040n;
  const block = new Uint8Array(128);
  let offset = 0;
  // Every full block but the last is compressed as it comes; the last (possibly partial,
  // possibly empty for empty input) is zero-padded and flagged final.
  while (data.length - offset > 128) {
    block.set(data.subarray(offset, offset + 128));
    offset += 128;
    compress(h, block, BigInt(offset), false);
  }
  block.fill(0);
  block.set(data.subarray(offset));
  compress(h, block, BigInt(data.length), true);
  const out = new Uint8Array(64);
  const view = new DataView(out.buffer);
  h.forEach((word, i) => view.setBigUint64(i * 8, word, true));
  return out;
};
