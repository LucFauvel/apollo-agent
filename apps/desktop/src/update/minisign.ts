/**
 * minisign signature verification (https://jedisct1.github.io/minisign/), the format CI signs
 * `apollo-update.json` with (RELEASE-SETUP.md §3.5):
 *
 *   public key   base64( "Ed" | key id (8) | Ed25519 public key (32) )
 *   .minisig     untrusted comment: …
 *                base64( "ED" | key id (8) | Ed25519 signature of BLAKE2b-512(file) (64) )
 *                trusted comment: …
 *                base64( Ed25519 signature of (signature (64) | trusted comment) (64) )
 *
 * Only the prehashed "ED" algorithm (minisign ≥ 0.8's default, what CI's 0.11+ makes) is
 * accepted; the legacy "Ed" form is refused. A signature verifies only against a key it names
 * by id among the keys given, so a key that is not embedded in the app can never be accepted.
 */
import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { blake2b512 } from "./blake2b.ts";

export interface MinisignPublicKey {
  /** The key id, as minisign prints it (16 hex digits, most significant byte first). */
  readonly id: string;
  readonly key: KeyObject;
}

const b64 = (text: string): Buffer | null => {
  const t = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t) || t.length % 4 !== 0) return null;
  return Buffer.from(t, "base64");
};

/** minisign shows key ids as the little-endian 64-bit number in hex. */
const keyIdHex = (bytes: Uint8Array) => Buffer.from(bytes).reverse().toString("hex").toUpperCase();

/**
 * A public key: the base64 line (`RW…`) alone, or a whole `minisign.pub` file (its untrusted
 * comment line is ignored). Throws on anything else.
 */
export const parsePublicKey = (text: string): MinisignPublicKey => {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.length === 2 && lines[0]!.startsWith("untrusted comment:") ? lines[1]! : lines.length === 1 ? lines[0]! : null;
  const raw = line ? b64(line) : null;
  if (!raw || raw.length !== 42) throw new Error("not a minisign public key");
  if (raw[0] !== 0x45 || raw[1] !== 0x64) throw new Error("not an Ed25519 minisign public key");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10).toString("base64url") }, format: "jwk" });
  return { id: keyIdHex(raw.subarray(2, 10)), key };
};

interface ParsedSignature {
  readonly algorithm: string;
  readonly keyId: string;
  readonly signature: Buffer;
  readonly trustedComment: string;
  readonly globalSignature: Buffer;
}

const parseSignature = (text: string): ParsedSignature | string => {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length !== 4) return "the signature file does not have 4 lines";
  const [untrusted, sigLine, trusted, globalLine] = lines as [string, string, string, string];
  if (!untrusted.startsWith("untrusted comment:")) return "the signature file has no untrusted comment line";
  const sig = b64(sigLine);
  if (!sig || sig.length !== 74) return "the signature line is malformed";
  if (!trusted.startsWith("trusted comment: ")) return "the signature file has no trusted comment";
  const globalSignature = b64(globalLine);
  if (!globalSignature || globalSignature.length !== 64) return "the trusted comment signature is malformed";
  return {
    algorithm: sig.subarray(0, 2).toString("latin1"),
    keyId: keyIdHex(sig.subarray(2, 10)),
    signature: sig.subarray(10),
    trustedComment: trusted.slice("trusted comment: ".length),
    globalSignature,
  };
};

export type MinisignVerdict =
  | { readonly ok: true; readonly keyId: string; readonly trustedComment: string }
  | { readonly ok: false; readonly reason: string };

/** Verifies `data` against a `.minisig` text with one of `keys`. Never throws. */
export const verifyMinisign = (data: Uint8Array, signatureText: string, keys: ReadonlyArray<MinisignPublicKey>): MinisignVerdict => {
  try {
    const parsed = parseSignature(signatureText);
    if (typeof parsed === "string") return { ok: false, reason: parsed };
    if (parsed.algorithm !== "ED") {
      return { ok: false, reason: parsed.algorithm === "Ed" ? "legacy (non-prehashed) minisign signatures are not accepted" : "unknown signature algorithm" };
    }
    const key = keys.find((k) => k.id === parsed.keyId);
    if (!key) return { ok: false, reason: `signed by key ${parsed.keyId}, which this app does not trust` };
    if (!verify(null, blake2b512(data), key.key, parsed.signature)) return { ok: false, reason: "the signature does not match the file" };
    const signedComment = Buffer.concat([parsed.signature, Buffer.from(parsed.trustedComment, "utf8")]);
    if (!verify(null, signedComment, key.key, parsed.globalSignature)) return { ok: false, reason: "the trusted comment signature does not match" };
    return { ok: true, keyId: key.id, trustedComment: parsed.trustedComment };
  } catch (error) {
    return { ok: false, reason: `verification failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};
