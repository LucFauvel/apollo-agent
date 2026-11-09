/**
 * Prints the version stamp for this checkout (see version.ts) and, in GitHub Actions, writes it
 * to $GITHUB_OUTPUT as `version`, `channel`, `bundle_version` and `commit`.
 *
 *   node apps/desktop/scripts/release/stamp.ts
 *
 * Needs full history and tags (actions/checkout with fetch-depth: 0). A tag build also checks
 * that the tagged commit is on origin/main: a release is never built from anything else.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolveStamp } from "./version.ts";

const git = (...args: Array<string>) => execFileSync("git", args, { encoding: "utf8" }).trim();

const ref = process.env.GITHUB_ACTIONS === "true" ? (process.env.GITHUB_REF ?? null) : null;
const commit = git("rev-parse", "HEAD");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit) {
  throw new Error(`checked out ${commit}, but GITHUB_SHA is ${process.env.GITHUB_SHA}`);
}
if (git("rev-parse", "--is-shallow-repository") === "true") throw new Error("shallow clone: check out with fetch-depth: 0");

if (ref?.startsWith("refs/tags/")) {
  // Exit status 1 = not an ancestor; anything else is an error. Both fail the build.
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "origin/main"]);
  } catch {
    throw new Error(`${ref} points at ${commit}, which is not on origin/main: refusing to build a release from it`);
  }
}

const stamp = resolveStamp({
  ref,
  commit,
  runNumber: process.env.GITHUB_RUN_NUMBER ? Number(process.env.GITHUB_RUN_NUMBER) : null,
  commitCount: Number(git("rev-list", "--count", commit)),
  tags: git("tag", "--merged", commit, "--list", "v*").split("\n").filter(Boolean),
  now: new Date(),
});

console.log(`version ${stamp.version} (${stamp.channel}), CFBundleVersion ${stamp.bundleVersion}, commit ${stamp.commit}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${stamp.version}\nchannel=${stamp.channel}\nbundle_version=${stamp.bundleVersion}\ncommit=${stamp.commit}\n`,
  );
}
