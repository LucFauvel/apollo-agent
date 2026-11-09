/**
 * Collects the platform builds' outputs (each: assets + apollo-update.<platform>-<arch>.json +
 * SHA256SUMS) into one release directory: the assets, the merged apollo-update.json and one
 * SHA256SUMS. Every asset is re-hashed against its partial manifest and SUMS first.
 *
 *   node apps/desktop/scripts/release/merge-manifests.ts --out <dir> --version X.Y.Z --commit <sha> <build dir>...
 *
 * A release must cover exactly RELEASE_TARGETS (manifest.ts), be signed per RELEASE_SIGNING
 * (release-checks.ts: macOS Developer ID; Windows Authenticode or, for now, unsigned), and its
 * version and commit must be the ones given (the tag's).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  compareAssets,
  formatSums,
  type Manifest,
  MANIFEST_NAME,
  mergeManifests,
  parseManifest,
  parseSums,
  RELEASE_TARGETS,
  sha256File,
  SUMS_NAME,
} from "./manifest.ts";
import { RELEASE_SIGNING } from "./release-checks.ts";

const args = process.argv.slice(2);
const take = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) return undefined;
  return args.splice(i, 2)[1];
};
const out = take("--out");
const version = take("--version");
const commit = take("--commit");
if (!out || !version || !commit || args.length === 0) {
  console.error("usage: merge-manifests.ts --out <dir> --version X.Y.Z --commit <sha> <build dir>...");
  process.exit(2);
}

const PARTIAL = /^apollo-update\.[a-z0-9]+-[a-z0-9]+\.json$/;
const parts: Array<{ dir: string; manifest: Manifest }> = [];
const problems: Array<string> = [];
for (const dir of args.map((d) => resolve(d))) {
  const files = readdirSync(dir);
  const partials = files.filter((f) => PARTIAL.test(f));
  if (partials.length !== 1) {
    problems.push(`${dir}: expected one partial manifest, found ${partials.length}`);
    continue;
  }
  const manifest = parseManifest(readFileSync(join(dir, partials[0]!), "utf8"));
  const recomputed = new Map<string, { size: number; sha256: string }>();
  for (const f of files) if (f !== partials[0] && f !== SUMS_NAME) recomputed.set(f, await sha256File(join(dir, f)));
  const sums = existsSync(join(dir, SUMS_NAME)) ? parseSums(readFileSync(join(dir, SUMS_NAME), "utf8")) : new Map<string, string>();
  problems.push(...compareAssets(manifest, sums, recomputed).map((p) => `${dir}: ${p}`));
  parts.push({ dir, manifest });
}
if (problems.length) {
  console.error(`✗ the builds do not check out:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

const merged = (() => {
  try {
    return mergeManifests(
      parts.map((p) => p.manifest),
      RELEASE_TARGETS,
    );
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    return process.exit(1);
  }
})();
if (merged.version !== version) problems.push(`builds are version ${merged.version}, expected ${version}`);
if (merged.commit !== commit) problems.push(`builds are from ${merged.commit}, expected ${commit}`);
if (merged.channel !== "release") problems.push(`builds are channel ${merged.channel}, expected release`);
for (const asset of merged.assets) {
  const allowed = RELEASE_SIGNING[asset.platform];
  if (!allowed.includes(asset.codeSigning.kind)) problems.push(`${asset.name} is ${asset.codeSigning.kind}: a ${asset.platform} release needs ${allowed.join(" or ")}`);
}
if (problems.length) {
  console.error(`✗ ${problems.join("\n  - ")}`);
  process.exit(1);
}

const outDir = resolve(out);
mkdirSync(outDir, { recursive: true });
if (readdirSync(outDir).length) {
  console.error(`✗ ${outDir} is not empty`);
  process.exit(1);
}
for (const { dir, manifest } of parts) for (const a of manifest.assets) copyFileSync(join(dir, a.name), join(outDir, a.name));
writeFileSync(join(outDir, MANIFEST_NAME), `${JSON.stringify(merged, null, 2)}\n`);
writeFileSync(join(outDir, SUMS_NAME), formatSums(merged.assets));
console.log(`✓ ${merged.version} (${merged.commit}): ${merged.assets.map((a) => `${a.name} [${a.platform}-${a.arch}, ${a.codeSigning.kind}]`).join(", ")}`);
