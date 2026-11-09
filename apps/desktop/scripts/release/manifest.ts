/**
 * The release manifest (`apollo-update.json`, design §4.3) and SHA256SUMS. CI writes both into a
 * draft release; `pnpm release:publish` recomputes every hash and (later) signs the manifest with
 * minisign. Only the manifest is ever signed: it carries the size and SHA-256 of every asset.
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import type { Channel } from "./version.ts";

export const MANIFEST_NAME = "apollo-update.json";
export const SIGNATURE_NAME = `${MANIFEST_NAME}.minisig`;
export const SUMS_NAME = "SHA256SUMS";

export interface ManifestAsset {
  readonly name: string;
  readonly arch: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * How the app inside was code-signed. `adhoc` builds are NOT releasable: no stable designated
 * requirement (TCC permissions reset on every update) and Gatekeeper blocks them when quarantined.
 */
export type CodeSigning = { readonly kind: "adhoc" } | { readonly kind: "developer-id"; readonly team: string };

export interface Manifest {
  readonly format: 1;
  readonly version: string;
  readonly build: number;
  readonly commit: string;
  readonly channel: Channel;
  readonly schemaVersion: number;
  readonly minMacos: string;
  readonly publishedAt: string;
  readonly codeSigning: CodeSigning;
  readonly assets: ReadonlyArray<ManifestAsset>;
  readonly notes: string;
}

export const sha256File = (path: string): Promise<{ size: number; sha256: string }> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve({ size: statSync(path).size, sha256: hash.digest("hex") }));
  });

export const describeAsset = async (path: string, arch: string): Promise<ManifestAsset> => ({
  name: basename(path),
  arch,
  ...(await sha256File(path)),
});

/** `shasum -a 256` format: `<hex>  <name>` per line, sorted by name. */
export const formatSums = (entries: ReadonlyArray<{ name: string; sha256: string }>): string =>
  [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `${e.sha256}  ${e.name}\n`)
    .join("");

export const parseSums = (text: string): Map<string, string> => {
  const sums = new Map<string, string>();
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9a-f]{64}) [ *](\S.*)$/.exec(line);
    if (!m) throw new Error(`${SUMS_NAME} line ${i + 1} is malformed`);
    if (sums.has(m[2]!)) throw new Error(`${SUMS_NAME} lists ${m[2]} twice`);
    sums.set(m[2]!, m[1]!);
  }
  return sums;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses and shape-checks a manifest; throws with the first problem found. */
export const parseManifest = (text: string): Manifest => {
  const m: unknown = JSON.parse(text);
  const fail = (why: string): never => {
    throw new Error(`${MANIFEST_NAME}: ${why}`);
  };
  if (!isObject(m)) return fail("not an object");
  if (m.format !== 1) fail(`unsupported format ${String(m.format)}`);
  if (typeof m.version !== "string" || !m.version) fail("missing version");
  if (typeof m.build !== "number" || !Number.isSafeInteger(m.build) || m.build < 1) fail("bad build");
  if (typeof m.commit !== "string" || !/^[0-9a-f]{40}$/.test(m.commit)) fail("bad commit");
  if (m.channel !== "release" && m.channel !== "nightly" && m.channel !== "local") fail("bad channel");
  if (typeof m.schemaVersion !== "number") fail("bad schemaVersion");
  const cs = m.codeSigning;
  if (!isObject(cs) || (cs.kind !== "adhoc" && !(cs.kind === "developer-id" && typeof cs.team === "string"))) fail("bad codeSigning");
  if (!Array.isArray(m.assets) || m.assets.length === 0) fail("no assets");
  const names = new Set<string>();
  for (const a of m.assets as Array<unknown>) {
    if (!isObject(a) || typeof a.name !== "string" || typeof a.arch !== "string") fail("bad asset entry");
    const asset = a as Record<string, unknown>;
    if (typeof asset.size !== "number" || typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256)) fail(`bad asset ${String(asset.name)}`);
    if (/[/\\]/.test(asset.name as string) || asset.name === MANIFEST_NAME || asset.name === SUMS_NAME) fail(`illegal asset name ${String(asset.name)}`);
    if (names.has(asset.name as string)) fail(`duplicate asset ${String(asset.name)}`);
    names.add(asset.name as string);
  }
  return m as unknown as Manifest;
};

/**
 * Every disagreement between the manifest, SHA256SUMS and what was actually recomputed from the
 * downloaded files. Empty means consistent. `recomputed` holds every file that was downloaded.
 */
export const compareAssets = (
  manifest: Manifest,
  sums: Map<string, string>,
  recomputed: Map<string, { size: number; sha256: string }>,
): Array<string> => {
  const problems: Array<string> = [];
  for (const asset of manifest.assets) {
    const actual = recomputed.get(asset.name);
    if (!actual) {
      problems.push(`${asset.name}: listed in the manifest but not in the release`);
      continue;
    }
    if (actual.sha256 !== asset.sha256) problems.push(`${asset.name}: sha256 ${actual.sha256} != manifest ${asset.sha256}`);
    if (actual.size !== asset.size) problems.push(`${asset.name}: size ${actual.size} != manifest ${asset.size}`);
    const listed = sums.get(asset.name);
    if (!listed) problems.push(`${asset.name}: missing from ${SUMS_NAME}`);
    else if (listed !== actual.sha256) problems.push(`${asset.name}: sha256 ${actual.sha256} != ${SUMS_NAME} ${listed}`);
  }
  const known = new Set([...manifest.assets.map((a) => a.name), MANIFEST_NAME, SUMS_NAME, SIGNATURE_NAME]);
  for (const name of recomputed.keys()) if (!known.has(name)) problems.push(`${name}: in the release but not in the manifest`);
  for (const name of sums.keys()) if (!manifest.assets.some((a) => a.name === name)) problems.push(`${name}: in ${SUMS_NAME} but not in the manifest`);
  return problems;
};
