/**
 * Writes build/build-info.json (the commit this app is built from, and the database schema
 * it expects). electron-builder ships it as Contents/Resources/build-info.json, so an
 * installed app says what it is: `cat /Applications/Apollo.app/Contents/Resources/build-info.json`.
 *
 * CI stamps the version (scripts/release/stamp.ts) through APOLLO_BUILD_VERSION,
 * APOLLO_BUILD_CHANNEL and APOLLO_BUILD_NUMBER. Without them the build is a `local` one.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION } from "../../server/src/Database.ts";
import type { BuildInfo } from "./install-app-lib.ts";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const git = (...args: Array<string>): string | null => {
  try {
    return execFileSync("git", args, { cwd: desktopDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

const CHANNELS = ["release", "nightly", "local"] as const;

/** The stamp fields from the environment; throws on a channel it does not know. */
export const stampFromEnv = (env: NodeJS.ProcessEnv, commit: string): Pick<BuildInfo, "version" | "channel" | "bundleVersion"> => {
  const channel = env.APOLLO_BUILD_CHANNEL || "local";
  if (!(CHANNELS as ReadonlyArray<string>).includes(channel)) throw new Error(`APOLLO_BUILD_CHANNEL=${channel} is not one of ${CHANNELS.join(", ")}`);
  if (channel !== "local" && !env.APOLLO_BUILD_VERSION) throw new Error(`a ${channel} build needs APOLLO_BUILD_VERSION`);
  return {
    version: env.APOLLO_BUILD_VERSION || `0.0.0-local+${commit.slice(0, 10)}`,
    channel: channel as (typeof CHANNELS)[number],
    ...(env.APOLLO_BUILD_NUMBER ? { bundleVersion: env.APOLLO_BUILD_NUMBER } : {}),
  };
};

export const buildInfo = (env: NodeJS.ProcessEnv = process.env): BuildInfo => {
  const commit = git("rev-parse", "HEAD") ?? "unknown";
  return {
    commit,
    // Untracked files count too: they can be part of the build.
    dirty: (git("status", "--porcelain") ?? "") !== "",
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    schemaVersion: SCHEMA_VERSION,
    builtAt: new Date().toISOString(),
    ...stampFromEnv(env, commit),
    arch: process.arch,
  };
};

export const describe = (info: BuildInfo) =>
  `${info.version ? `${info.version} (${info.channel}) ` : ""}${info.commit.slice(0, 10)}${info.dirty ? " (dirty)" : ""}${info.branch ? ` on ${info.branch}` : ""}, schema ${info.schemaVersion}`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = buildInfo();
  const out = join(desktopDir, "build", "build-info.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`);
  console.log(`build info: ${describe(info)} -> ${out}`);
}
