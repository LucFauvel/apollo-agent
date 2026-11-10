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
import { assetNameProblems, type Manifest, MANIFEST_FORMAT, MANIFEST_NAME, type ManifestAsset, SIGNATURE_NAME, SUMS_NAME, targetsOf } from "../../src/update/manifestFormat.ts";

// The format itself (types, parseManifest, asset names) is compiled into the app for its
// updater, so it lives in src/update/manifestFormat.ts; the release tooling re-exports it.
export * from "../../src/update/manifestFormat.ts";

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
  for (const part of parts) problems.push(...assetNameProblems(part));
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
  // Each name is exactly what its entry says it is (version, platform, arch, kind, signing).
  problems.push(...assetNameProblems(manifest));
  for (const name of recomputed.keys()) if (!known.has(name)) problems.push(`${name}: in the release but not in the manifest`);
  for (const name of sums.keys()) if (!manifest.assets.some((a) => a.name === name)) problems.push(`${name}: in ${SUMS_NAME} but not in the manifest`);
  return problems;
};
