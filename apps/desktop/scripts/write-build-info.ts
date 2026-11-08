/**
 * Writes build/build-info.json (the commit this app is built from, and the database schema
 * it expects). electron-builder ships it as Contents/Resources/build-info.json, so an
 * installed app says what it is: `cat /Applications/Apollo.app/Contents/Resources/build-info.json`.
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

export const buildInfo = (): BuildInfo => ({
  commit: git("rev-parse", "HEAD") ?? "unknown",
  // Untracked files count too: they can be part of the build.
  dirty: (git("status", "--porcelain") ?? "") !== "",
  branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  schemaVersion: SCHEMA_VERSION,
  builtAt: new Date().toISOString(),
});

export const describe = (info: BuildInfo) =>
  `${info.commit.slice(0, 10)}${info.dirty ? " (dirty)" : ""}${info.branch ? ` on ${info.branch}` : ""}, schema ${info.schemaVersion}`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = buildInfo();
  const out = join(desktopDir, "build", "build-info.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`);
  console.log(`build info: ${describe(info)} -> ${out}`);
}
