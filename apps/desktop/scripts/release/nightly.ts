/**
 * The nightly-publish job's checks and housekeeping (rules in nightly-lib.ts).
 *
 *   node apps/desktop/scripts/release/nightly.ts preflight --dir <merged dir> --version <v> --commit <sha>
 *     Refuses (exit 1) when the nightly key is missing, invalid or a release key, or the merged
 *     manifest is not this run's nightly. Writes <dir>/.trusted-comment and, in Actions,
 *     `tag` to $GITHUB_OUTPUT. Env: NIGHTLY_MINISIGN_PUBLIC_KEY, RELEASE_MINISIGN_PUBLIC_KEY.
 *
 *   node apps/desktop/scripts/release/nightly.ts prune --keep <n>
 *     Deletes all but the newest <n> `nightly-*` prereleases (and their tags) with `gh`.
 *     Never fails the job: a deletion GitHub refuses is a warning. Env: GH_TOKEN, GITHUB_REPOSITORY.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MANIFEST_NAME, parseManifest } from "./manifest.ts";
import { type ListedRelease, nightliesToPrune, nightlyKeyProblems, nightlyManifestProblems, nightlyTag } from "./nightly-lib.ts";
import { trustedComment } from "./release-checks.ts";

const [command, ...args] = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const inActions = process.env.GITHUB_ACTIONS === "true";
const warn = (text: string) => console.log(inActions ? `::warning title=Nightly::${text}` : `warning: ${text}`);

if (command === "preflight") {
  const dirArg = opt("--dir");
  const version = opt("--version");
  const commit = opt("--commit");
  if (!dirArg || !version || !commit) {
    console.error("usage: nightly.ts preflight --dir <merged dir> --version <v> --commit <sha>");
    process.exit(2);
  }
  const dir = resolve(dirArg);
  const keys = nightlyKeyProblems({ nightly: process.env.NIGHTLY_MINISIGN_PUBLIC_KEY ?? "", releaseVariable: process.env.RELEASE_MINISIGN_PUBLIC_KEY ?? "" });
  const manifest = parseManifest(readFileSync(join(dir, MANIFEST_NAME), "utf8"));
  const problems = [...keys.problems, ...nightlyManifestProblems(manifest, { version, commit })];
  for (const w of keys.warnings) warn(w);
  if (problems.length) {
    console.error(`✗ not publishing this nightly:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  writeFileSync(join(dir, ".trusted-comment"), trustedComment(manifest));
  const tag = nightlyTag(manifest.version);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
  console.log(`✓ nightly ${manifest.version} (build ${manifest.build}, ${manifest.commit}) → ${tag}`);
} else if (command === "prune") {
  const keep = Number(opt("--keep"));
  const repo = process.env.GITHUB_REPOSITORY ?? "LucFauvel/apollo-agent";
  const gh = (argv: ReadonlyArray<string>) => spawnSync("gh", argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const list = gh(["release", "list", "--repo", repo, "--limit", "200", "--json", "tagName,isPrerelease,isDraft,createdAt"]);
  if (list.status !== 0) {
    warn(`could not list releases to prune old nightlies: ${list.stderr.trim()}`);
    process.exit(0);
  }
  const stale = nightliesToPrune(JSON.parse(list.stdout) as Array<ListedRelease>, keep);
  for (const tag of stale) {
    const r = gh(["release", "delete", tag, "--repo", repo, "--yes", "--cleanup-tag"]);
    if (r.status === 0) console.log(`deleted old nightly ${tag}`);
    else warn(`could not delete old nightly ${tag}: ${r.stderr.trim()}`);
  }
  if (stale.length === 0) console.log(`nothing to prune (keeping the newest ${keep} nightlies)`);
} else {
  console.error("usage: nightly.ts preflight|prune …");
  process.exit(2);
}
