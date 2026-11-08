import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { deviceProofMessage } from "@apollo/contracts";

/** A proof older or newer than this is refused; phones keep their clocks in sync. */
export const PROOF_WINDOW_MS = 2 * 60 * 1000;
export const PROOF_HEADER = "x-apollo-proof";

const fromBase64Url = (value: string) => Buffer.from(value, "base64url");

/**
 * Parses a device public key: base64url of an uncompressed P-256 point (0x04 || X || Y),
 * as iOS exports Secure Enclave keys. Returns null for anything else.
 */
export const parseDeviceKey = (encoded: string): KeyObject | null => {
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(encoded)) return null;
  const point = fromBase64Url(encoded);
  if (point.length !== 65 || point[0] !== 0x04) return null;
  try {
    return createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
  } catch {
    // Not a point on the curve.
    return null;
  }
};

/**
 * Checks `x-apollo-proof: <timestamp ms>.<nonce>.<signature>` against a device key: an
 * ECDSA P-256 SHA-256 signature (DER, base64url) over the method, path, timestamp and
 * nonce. Each nonce is accepted once, so a captured proof cannot be replayed.
 */
export const makeProofVerifier = () => {
  const seen = new Map<string, number>();

  const forget = (now: number) => {
    for (const [nonce, expiry] of seen) if (expiry <= now) seen.delete(nonce);
  };

  return (
    header: string | undefined,
    key: KeyObject,
    request: { readonly method: string; readonly path: string },
    now = Date.now(),
  ): boolean => {
    if (!header) return false;
    const parts = header.trim().split(".");
    if (parts.length !== 3) return false;
    const [timestamp, nonce, signature] = parts as [string, string, string];
    if (!/^\d{1,16}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || signature.length > 200) return false;
    if (Math.abs(now - Number(timestamp)) > PROOF_WINDOW_MS) return false;
    if (seen.has(nonce)) return false;
    const message = Buffer.from(deviceProofMessage(request.method, request.path, timestamp, nonce));
    let valid = false;
    try {
      valid = verify("sha256", message, { key, dsaEncoding: "der" }, fromBase64Url(signature));
    } catch {
      valid = false;
    }
    if (!valid) return false;
    if (seen.size > 10_000) forget(now);
    seen.set(nonce, now + 2 * PROOF_WINDOW_MS);
    return true;
  };
};

export type ProofVerifier = ReturnType<typeof makeProofVerifier>;
