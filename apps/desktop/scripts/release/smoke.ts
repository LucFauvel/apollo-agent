/**
 * Release smoke test: launches the PACKAGED app against an OLD database and fails unless it
 * starts, migrates, answers /health, renders its window and exits cleanly.
 *
 *   node apps/desktop/scripts/release/smoke.ts --zip <Apollo-….zip> [--seed-version <n>]... [--timeout <s>]
 *   node apps/desktop/scripts/release/smoke.ts --app <Apollo.app> …
 *
 * For each seed version (default: 1, the very first schema, and the one just before the
 * current schema), in a throwaway directory:
 *  1. the zip is unpacked with `ditto -x -k` (the bytes that would be released, not the build dir);
 *  2. a database is created at that old schema version with a bot, sessions, events, a memory and
 *     a skill (smoke-lib.ts);
 *  3. the app's own executable runs with APOLLO_DATA_DIR / APOLLO_USER_DATA_DIR / HOME pointing
 *     into the throwaway directory and APOLLO_SCREENSHOT set: the app's existing automation mode,
 *     which starts the server, waits for /health, loads the UI offscreen, captures it and quits;
 *  4. while it runs, the bundled server's /health is asked directly (port found with ps + lsof,
 *     as install:app does) and must answer {"ok":true};
 *  5. the app must exit 0 within the timeout, leave no server process behind, have written a
 *     non-empty PNG, and the database must be at build-info's schemaVersion with the seed intact.
 *
 * What it does NOT cover (see RELEASE-SETUP.md): the tray, a visible window, an `open` launch
 * through LaunchServices/Gatekeeper, provider CLIs (none is installed on CI) and the tailnet
 * (not enabled in a fresh data dir). It runs the real packaged binary, not a simulation.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION } from "../../../server/src/Database.ts";
import { healthUrls, isHealthyResponse, launchEnv, type BuildInfo } from "../install-app-lib.ts";
import { checkMigratedDatabase, seedOldDatabase } from "./smoke-lib.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const values: Array<string> = [];
  args.forEach((a, i) => a === name && args[i + 1] && values.push(args[i + 1]!));
  return values;
};
const zip = opt("--zip")[0];
const appArg = opt("--app")[0];
const timeoutMs = Number(opt("--timeout")[0] ?? 180) * 1000;
const seedVersions = (opt("--seed-version").length ? opt("--seed-version").map(Number) : [1, SCHEMA_VERSION - 1]).filter(
  (v, i, all) => v >= 1 && all.indexOf(v) === i,
);
if (!zip === !appArg) {
  console.error("usage: smoke.ts (--zip <zip> | --app <Apollo.app>) [--seed-version <n>]... [--timeout <seconds>]");
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (command: string, argv: ReadonlyArray<string>) => spawnSync(command, argv, { encoding: "utf8", timeout: 10_000 });

const root = mkdtempSync(join(tmpdir(), "apollo-smoke-"));
let app = appArg ? resolve(appArg) : "";
if (zip) {
  const r = sh("ditto", ["-x", "-k", resolve(zip), join(root, "unpacked")]);
  if (r.status !== 0) throw new Error(`ditto -x -k failed: ${r.stderr}`);
  app = join(root, "unpacked", "Apollo.app");
}
if (!existsSync(app)) throw new Error(`no app at ${app}`);
const info = JSON.parse(readFileSync(join(app, "Contents", "Resources", "build-info.json"), "utf8")) as BuildInfo;
const executable = join(app, "Contents", "MacOS", sh("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", join(app, "Contents", "Info.plist")]).stdout.trim() || "apollo");
const serverEntry = join(app, "Contents", "Resources", "server", "server.mjs");
console.log(`▸ Smoke-testing ${info.version ?? "?"} (${info.commit.slice(0, 10)}, schema ${info.schemaVersion}) from ${app}`);
if (info.schemaVersion !== SCHEMA_VERSION) {
  console.log(`  (this checkout's schema is ${SCHEMA_VERSION}; seeding with this checkout's migrations ${seedVersions.join(", ")})`);
}

const serverPids = () =>
  sh("ps", ["-axo", "pid=,command="])
    .stdout.split("\n")
    .flatMap((line) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      return m && m[2]!.includes(serverEntry) ? [Number(m[1])] : [];
    });

const healthOnce = async (): Promise<string | null> => {
  for (const pid of serverPids()) {
    const env = sh("ps", ["eww", "-o", "command=", "-p", String(pid)]).stdout;
    const lsof = sh("lsof", ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n"]).stdout;
    for (const url of healthUrls(env, lsof)) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (isHealthyResponse(response.status, await response.text())) return url;
      } catch {
        // not up yet
      }
    }
  }
  return null;
};

const runOnce = async (seedVersion: number): Promise<Array<string>> => {
  const dir = join(root, `seed-v${seedVersion}`);
  const dataDir = join(dir, "data");
  const home = join(dir, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const dbPath = join(dataDir, "apollo.db");
  seedOldDatabase(dbPath, MIGRATIONS, seedVersion);
  const screenshot = join(dir, "window.png");
  const logPath = join(dir, "app.log");
  const log = openSync(logPath, "a");
  console.log(`▸ seed schema ${seedVersion} → app (log ${logPath})`);
  const child = spawn(executable, [], {
    cwd: home,
    stdio: ["ignore", log, log],
    env: {
      // Allowlisted like install:app's launches: no ELECTRON_RUN_AS_NODE or APOLLO_* leaks in.
      ...launchEnv(process.env),
      HOME: home,
      APOLLO_DATA_DIR: dataDir,
      APOLLO_USER_DATA_DIR: join(dir, "electron"),
      APOLLO_SCREENSHOT: screenshot,
      // Long enough for /health to be asked from outside before the app quits.
      APOLLO_SCREENSHOT_DELAY: "6000",
    },
  });
  let exit: { code: number | null; signal: string | null } | null = null;
  const exited = new Promise<void>((r) => child.once("exit", (code, signal) => ((exit = { code, signal }), r())));
  const problems: Array<string> = [];
  const deadline = Date.now() + timeoutMs;
  let health: string | null = null;
  while (!health && !exit && Date.now() < deadline) {
    health = await healthOnce();
    if (!health) await sleep(250);
  }
  if (health) console.log(`  /health answered at ${health}`);
  else problems.push(exit ? `the app exited (${JSON.stringify(exit)}) before /health answered` : "/health never answered");
  await Promise.race([exited, sleep(Math.max(0, deadline - Date.now()))]);
  if (!exit) {
    problems.push(`the app did not exit within ${timeoutMs / 1000}s`);
    child.kill("SIGKILL");
    await exited;
  } else if ((exit as { code: number | null }).code !== 0) problems.push(`the app exited with ${JSON.stringify(exit)}`);
  await sleep(1000);
  const leftovers = serverPids();
  if (leftovers.length) {
    problems.push(`server processes left behind: ${leftovers.join(", ")}`);
    for (const pid of leftovers) process.kill(pid, "SIGKILL");
  }
  if (!existsSync(screenshot) || statSync(screenshot).size === 0) problems.push("no window screenshot: the UI did not load");
  problems.push(...checkMigratedDatabase(dbPath, info.schemaVersion));
  if (problems.length) console.error(`--- app log (seed ${seedVersion}) ---\n${readFileSync(logPath, "utf8").slice(-8000)}\n---`);
  return problems.map((p) => `seed schema ${seedVersion}: ${p}`);
};

const failures: Array<string> = [];
try {
  for (const v of seedVersions) failures.push(...(await runOnce(v)));
} finally {
  if (!process.env.APOLLO_SMOKE_KEEP) rmSync(root, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`✗ smoke test failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`✓ smoke test passed (seed schemas ${seedVersions.join(", ")} → ${info.schemaVersion})`);
