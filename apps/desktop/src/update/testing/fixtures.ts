/**
 * Test fixtures: throwaway minisign keypairs and a minisign signer built on Node's own crypto
 * (Node has blake2b512, so the signing side is independent of src/update/blake2b.ts). Never
 * used by the app; excluded from the build with the tests.
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import type { Manifest } from "../manifestFormat.ts";

export interface TestKey {
  readonly publicLine: string;
  readonly id: Buffer;
  readonly privateKey: KeyObject;
}

export const makeKey = (): TestKey => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const id = randomBytes(8);
  return { publicLine: Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64"), id, privateKey };
};

/** A `.minisig` for `data`, as `minisign -S -t <comment>` writes it (prehashed "ED"). */
export const minisign = (data: Uint8Array, key: TestKey, trustedComment: string, o: { algorithm?: string; keyId?: Buffer } = {}): string => {
  const algorithm = o.algorithm ?? "ED";
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : Buffer.from(data);
  const signature = sign(null, message, key.privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), key.privateKey);
  const line = Buffer.concat([Buffer.from(algorithm, "latin1"), o.keyId ?? key.id, signature]).toString("base64");
  return `untrusted comment: signature from minisign secret key\n${line}\ntrusted comment: ${trustedComment}\n${global.toString("base64")}\n`;
};

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const TEAM = "XA3R5NAN2C";

export const comment = (m: Pick<Manifest, "version" | "build" | "commit">) => `apollo-update version=${m.version} build=${m.build} commit=${m.commit}`;

export const manifest = (over: Partial<Manifest> = {}): Manifest => {
  const version = over.version ?? "1.3.0";
  return {
    format: 2,
    version,
    build: 500,
    commit: COMMIT,
    channel: "release",
    schemaVersion: 20,
    publishedAt: "2026-11-09T00:00:00Z",
    notes: "",
    assets: [
      { name: `Apollo-${version}-arm64.zip`, platform: "darwin", arch: "arm64", kind: "zip", size: 1000, sha256: "a".repeat(64), codeSigning: { kind: "developer-id", team: TEAM }, minOs: "12.0" },
      { name: `Apollo-${version}-arm64.dmg`, platform: "darwin", arch: "arm64", kind: "dmg", size: 2000, sha256: "b".repeat(64), codeSigning: { kind: "developer-id", team: TEAM }, minOs: "12.0" },
      { name: `Apollo-${version}-win-x64-unsigned-setup.exe`, platform: "win32", arch: "x64", kind: "nsis", size: 3000, sha256: "c".repeat(64), codeSigning: { kind: "unsigned" }, minOs: "10" },
    ],
    ...over,
  };
};
