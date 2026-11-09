/**
 * The release manifest (`apollo-update.json`, design §4.3) and SHA256SUMS.
 *
 * Format 2: one manifest per release covering every platform. Each asset says which platform,
 * architecture and kind it is and how it is code-signed. Each platform build writes a PARTIAL
 * manifest with only its own assets (`apollo-update.<platform>-<arch>.json`); the draft-release
 * job merges them (mergeManifests) into `apollo-update.json`, which CI signs with minisign. Only
 * the merged manifest is signed: it carries the size and SHA-256 of every asset.
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import type { Channel } from "./version.ts";

export const MANIFEST_NAME = "apollo-update.json";
export const SIGNATURE_NAME = `${MANIFEST_NAME}.minisig`;
export const SUMS_NAME = "SHA256SUMS";
export const MANIFEST_FORMAT = 2;

export type Platform = "darwin" | "win32";
export type AssetKind = "zip" | "dmg" | "nsis";

/** Every release must carry exactly these platform/arch targets. */
export const RELEASE_TARGETS: ReadonlyArray<`${Platform}-${string}`> = ["darwin-arm64", "win32-x64", "win32-arm64"];

/** Name of a platform build's partial manifest, e.g. apollo-update.win32-x64.json. */
export const partialManifestName = (platform: Platform, arch: string) => `apollo-update.${platform}-${arch}.json`;

/**
 * How the app in an asset is code-signed.
 *  - macOS: `developer-id` (releasable) or `adhoc` (NOT releasable: no stable designated
 *    requirement, so TCC permissions reset on every update; Gatekeeper blocks it once quarantined).
 *  - Windows: `authenticode` (Azure Trusted Signing, future) or `unsigned` (allowed for now,
 *    with "-unsigned" in the file name; SmartScreen warns on first run).
 */
export type CodeSigning =
  | { readonly kind: "developer-id"; readonly team: string }
  | { readonly kind: "adhoc" }
  | { readonly kind: "authenticode"; readonly publisher: string }
  | { readonly kind: "unsigned" };

export interface ManifestAsset {
  readonly name: string;
  readonly platform: Platform;
  readonly arch: string;
  readonly kind: AssetKind;
  readonly size: number;
  readonly sha256: string;
  readonly codeSigning: CodeSigning;
  /** Oldest OS version the app runs on (macOS LSMinimumSystemVersion; Windows "10"). */
  readonly minOs: string;
}

export interface Manifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly version: string;
  readonly build: number;
  readonly commit: string;
  readonly channel: Channel;
  readonly schemaVersion: number;
  readonly publishedAt: string;
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

export const describeAsset = async (
  path: string,
  meta: Pick<ManifestAsset, "platform" | "arch" | "kind" | "codeSigning" | "minOs">,
): Promise<ManifestAsset> => ({ name: basename(path), ...meta, ...(await sha256File(path)) });

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

const PLATFORMS: ReadonlyArray<string> = ["darwin", "win32"];
const KINDS: Record<Platform, ReadonlyArray<string>> = { darwin: ["zip", "dmg"], win32: ["nsis"] };
const SIGNINGS: Record<Platform, ReadonlyArray<string>> = { darwin: ["developer-id", "adhoc"], win32: ["authenticode", "unsigned"] };

const isCodeSigning = (v: unknown, platform: Platform): v is CodeSigning => {
  if (!isObject(v) || typeof v.kind !== "string" || !SIGNINGS[platform].includes(v.kind)) return false;
  if (v.kind === "developer-id") return typeof v.team === "string" && /^[A-Z0-9]{10}$/.test(v.team);
  if (v.kind === "authenticode") return typeof v.publisher === "string" && v.publisher !== "";
  return true;
};

/** Parses and shape-checks a manifest (full or partial); throws with the first problem found. */
export const parseManifest = (text: string): Manifest => {
  const m: unknown = JSON.parse(text);
  const fail = (why: string): never => {
    throw new Error(`${MANIFEST_NAME}: ${why}`);
  };
  if (!isObject(m)) return fail("not an object");
  if (m.format !== MANIFEST_FORMAT) fail(`unsupported format ${String(m.format)}`);
  if (typeof m.version !== "string" || !m.version) fail("missing version");
  if (typeof m.build !== "number" || !Number.isSafeInteger(m.build) || m.build < 1) fail("bad build");
  if (typeof m.commit !== "string" || !/^[0-9a-f]{40}$/.test(m.commit)) fail("bad commit");
  if (m.channel !== "release" && m.channel !== "nightly" && m.channel !== "local") fail("bad channel");
  if (typeof m.schemaVersion !== "number") fail("bad schemaVersion");
  if (!Array.isArray(m.assets) || m.assets.length === 0) fail("no assets");
  const names = new Set<string>();
  for (const raw of m.assets as Array<unknown>) {
    if (!isObject(raw)) return fail("bad asset entry");
    const a = raw;
    const label = String(a.name);
    if (typeof a.name !== "string" || typeof a.arch !== "string" || !a.arch) fail(`bad asset entry ${label}`);
    if (typeof a.platform !== "string" || !PLATFORMS.includes(a.platform)) fail(`${label}: bad platform ${String(a.platform)}`);
    const platform = a.platform as Platform;
    if (typeof a.kind !== "string" || !KINDS[platform].includes(a.kind)) fail(`${label}: bad kind ${String(a.kind)} for ${platform}`);
    if (!isCodeSigning(a.codeSigning, platform)) fail(`${label}: bad codeSigning for ${platform}`);
    if (typeof a.minOs !== "string" || !a.minOs) fail(`${label}: missing minOs`);
    if (typeof a.size !== "number" || typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) fail(`bad asset ${label}`);
    if (/[/\\]/.test(a.name as string) || (a.name as string).startsWith(".") || (a.name as string).startsWith("apollo-update") || a.name === SUMS_NAME) {
      fail(`illegal asset name ${label}`);
    }
    if (names.has(a.name as string)) fail(`duplicate asset ${label}`);
    names.add(a.name as string);
  }
  return m as unknown as Manifest;
};

/** The platform-arch targets a manifest covers, e.g. ["darwin-arm64", "win32-x64"]. */
export const targetsOf = (m: Pick<Manifest, "assets">): Array<string> =>
  [...new Set(m.assets.map((a) => `${a.platform}-${a.arch}`))].sort();

/**
 * Merges the platform builds' partial manifests into the release manifest. They must agree on
 * version, build, commit, channel and schema, never repeat an asset name or a target, and, when
 * `required` is given, cover exactly those targets.
 */
export const mergeManifests = (parts: ReadonlyArray<Manifest>, required?: ReadonlyArray<string>, notes = ""): Manifest => {
  if (parts.length === 0) throw new Error("no partial manifests to merge");
  const first = parts[0]!;
  const problems: Array<string> = [];
  const seenTargets = new Set<string>();
  const seenNames = new Set<string>();
  for (const part of parts) {
    for (const key of ["version", "build", "commit", "channel", "schemaVersion"] as const) {
      if (part[key] !== first[key]) problems.push(`${key} differs between builds: ${String(first[key])} vs ${String(part[key])}`);
    }
    for (const target of targetsOf(part)) {
      if (seenTargets.has(target)) problems.push(`${target} is built twice`);
      seenTargets.add(target);
    }
    for (const a of part.assets) {
      if (seenNames.has(a.name)) problems.push(`asset ${a.name} appears twice`);
      seenNames.add(a.name);
    }
  }
  if (required) {
    for (const t of required) if (!seenTargets.has(t)) problems.push(`missing build for ${t}`);
    for (const t of seenTargets) if (!required.includes(t)) problems.push(`unexpected build for ${t}`);
  }
  if (problems.length) throw new Error(`cannot merge manifests:\n  - ${[...new Set(problems)].join("\n  - ")}`);
  const assets = parts.flatMap((p) => p.assets).sort((a, b) => a.name.localeCompare(b.name));
  const publishedAt = parts.map((p) => p.publishedAt).sort().at(-1)!;
  return { ...first, format: MANIFEST_FORMAT, publishedAt, assets, notes };
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
  // Each asset's name carries the manifest's version: no file of another build slips in.
  for (const asset of manifest.assets) if (!asset.name.includes(`-${manifest.version}-`)) problems.push(`${asset.name}: name does not carry version ${manifest.version}`);
  for (const name of recomputed.keys()) if (!known.has(name)) problems.push(`${name}: in the release but not in the manifest`);
  for (const name of sums.keys()) if (!manifest.assets.some((a) => a.name === name)) problems.push(`${name}: in ${SUMS_NAME} but not in the manifest`);
  return problems;
};
