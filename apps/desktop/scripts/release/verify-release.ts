/**
 * Downloads a GitHub release's assets and checks them (release-checks.ts) before CI signs the
 * draft (`--stage sign`) or promotes it to stable (`--stage promote`). Exits 1 on any problem.
 *
 *   node apps/desktop/scripts/release/verify-release.ts --tag v0.4.0 --stage sign|promote \
 *     --dir <empty dir> [--public-key <minisign public key line>] [--workflow desktop.yml]
 *
 * Needs `gh` (GH_TOKEN), `git` with origin/main and tags fetched, `minisign` when the release has
 * a signature. In GitHub Actions it writes `version`, `commit` and `build` to $GITHUB_OUTPUT.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkRelease, type Stage, trustedComment } from "./release-checks.ts";
import { compareAssets, MANIFEST_NAME, parseManifest, parseSums, sha256File, SIGNATURE_NAME, SUMS_NAME } from "./manifest.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const tag = opt("--tag");
const stage = opt("--stage") as Stage | undefined;
const dirArg = opt("--dir");
const publicKey = opt("--public-key") ?? process.env.RELEASE_MINISIGN_PUBLIC_KEY ?? "";
const workflow = opt("--workflow") ?? "desktop.yml";
if (!tag || (stage !== "sign" && stage !== "promote") || !dirArg) {
  console.error("usage: verify-release.ts --tag vX.Y.Z --stage sign|promote --dir <dir> [--public-key <key>]");
  process.exit(2);
}
const dir = resolve(dirArg);
const repo = process.env.GITHUB_REPOSITORY ?? "LucFauvel/apollo-agent";

const run = (command: string, argv: ReadonlyArray<string>, input?: string) => {
  const r = spawnSync(command, argv, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const must = (command: string, argv: ReadonlyArray<string>) => {
  const r = run(command, argv);
  if (!r.ok) throw new Error(`${command} ${argv.join(" ")} failed: ${r.err}`);
  return r.out;
};

const view = JSON.parse(must("gh", ["release", "view", tag, "--repo", repo, "--json", "isDraft,isPrerelease,tagName"])) as {
  isDraft: boolean;
  isPrerelease: boolean;
};
mkdirSync(dir, { recursive: true });
if (readdirSync(dir).length) throw new Error(`${dir} is not empty`);
must("gh", ["release", "download", tag, "--repo", repo, "--dir", dir]);

const manifest = parseManifest(readFileSync(join(dir, MANIFEST_NAME), "utf8"));
const sums = parseSums(readFileSync(join(dir, SUMS_NAME), "utf8"));
const recomputed = new Map<string, { size: number; sha256: string }>();
for (const name of readdirSync(dir)) recomputed.set(name, await sha256File(join(dir, name)));

const tagCommit = (() => {
  const r = run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  return r.ok ? r.out : null;
})();
const onMain = tagCommit !== null && run("git", ["merge-base", "--is-ancestor", tagCommit, "origin/main"]).ok;

const signature = ((): "absent" | "valid" | "invalid" => {
  if (!recomputed.has(SIGNATURE_NAME)) return "absent";
  if (!publicKey) throw new Error(`the release has ${SIGNATURE_NAME} but no minisign public key was given to check it`);
  const r = run("minisign", ["-V", "-P", publicKey, "-m", join(dir, MANIFEST_NAME), "-x", join(dir, SIGNATURE_NAME)]);
  // The trusted comment must be the one this manifest would get: it binds version and commit.
  return r.ok && r.out.includes(`Trusted comment: ${trustedComment(manifest)}`) ? "valid" : "invalid";
})();

const nightlyGreen = (() => {
  if (stage !== "promote") return false;
  const count = must("gh", [
    "api",
    `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${manifest.commit}&branch=main&event=push&status=success&per_page=1`,
    "--jq",
    ".total_count",
  ]);
  return Number(count) > 0;
})();

const problems = checkRelease(
  { tag, tagCommit, onMain, release: view, manifest, assetProblems: compareAssets(manifest, sums, recomputed), signature, nightlyGreen },
  stage,
);
if (problems.length) {
  console.error(`✗ ${tag} cannot be ${stage === "sign" ? "signed" : "promoted"}:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
writeFileSync(join(dir, ".trusted-comment"), trustedComment(manifest));
console.log(`✓ ${tag}: ${manifest.version} build ${manifest.build} from ${manifest.commit}, ${manifest.assets.length} assets verified (${stage})`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${manifest.version}\ncommit=${manifest.commit}\nbuild=${manifest.build}\n`);
}
