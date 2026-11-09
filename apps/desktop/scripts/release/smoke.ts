/**
 * Release smoke test: launches the PACKAGED app against an OLD database and fails unless it
 * starts, migrates, answers /health, renders its window and exits cleanly. macOS and Windows.
 *
 *   node apps/desktop/scripts/release/smoke.ts --zip <Apollo-….zip>          (macOS: the released zip)
 *   node apps/desktop/scripts/release/smoke.ts --app <Apollo.app>            (macOS: an app bundle)
 *   node apps/desktop/scripts/release/smoke.ts --nsis <…-setup.exe>          (Windows: the released installer)
 *   node apps/desktop/scripts/release/smoke.ts --dir <win-unpacked>          (Windows: an unpacked app)
 *     [--seed-version <n>]... [--timeout <s>] [--app-arg <chromium switch>]...
 *
 * For each seed version (default: 1, the very first schema, and the one just before the
 * current schema), in a throwaway directory:
 *  1. macOS: the zip is unpacked with `ditto -x -k`. Windows: the installer runs silently
 *     (`/S /D=<throwaway dir>`, per-user, no elevation) and is uninstalled afterwards. This
 *     touches HKCU and the Start menu, so outside CI it needs --allow-install;
 *  2. a database is created at that old schema version with a bot, sessions, events, a memory and
 *     a skill (smoke-lib.ts);
 *  3. the app's own executable runs with APOLLO_DATA_DIR / APOLLO_USER_DATA_DIR / HOME
 *     (USERPROFILE on Windows) pointing into the throwaway directory and APOLLO_SCREENSHOT set:
 *     the app's existing automation mode, which starts the server, waits for /health, loads the
 *     UI offscreen, captures it and quits;
 *  4. while it runs, the server's own "Listening on http://127.0.0.1:<port>" line in the app's
 *     output gives the port, and /health is asked from outside: it must answer {"ok":true};
 *  5. the app must exit 0 within the timeout; within --shutdown-grace seconds (default 3) nothing of
 *     it may remain: no process descended from it (sampled while it ran), none running from its
 *     bundle / install directory, and nothing accepting connections on its server's port, healthy
 *     or not (survivors are killed, and the run fails); a non-empty PNG must exist, and the database must be at build-info's
 *     schemaVersion with the seed intact. With APOLLO_BUILD_VERSION/APOLLO_BUILD_COMMIT set, the
 *     app's build-info.json must carry them.
 *
 * What it does NOT cover (see RELEASE-SETUP.md): the tray, a visible window, an `open` launch
 * through LaunchServices/Gatekeeper or SmartScreen, provider CLIs (none on CI) and the tailnet
 * (not enabled in a fresh data dir). It runs the real packaged binary, not a simulation.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION } from "../../../server/src/Database.ts";
import { isHealthyResponse, launchEnv, type BuildInfo } from "../install-app-lib.ts";
import {
  checkMigratedDatabase,
  descendantsOf,
  parsePs,
  parseWinProcesses,
  portAccepts,
  type Proc,
  processesUnder,
  runSilentInstall,
  seedOldDatabase,
  serverUrlFromLog,
  smokeEnv,
} from "./smoke-lib.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const values: Array<string> = [];
  args.forEach((a, i) => a === name && args[i + 1] && values.push(args[i + 1]!));
  return values;
};
const zip = opt("--zip")[0];
const appArg = opt("--app")[0];
const nsis = opt("--nsis")[0];
const dirArg = opt("--dir")[0];
const appArgs = opt("--app-arg");
const timeoutMs = Number(opt("--timeout")[0] ?? 180) * 1000;
/** How long the app's processes and port get to disappear after it exits; anything left after that fails. */
const shutdownGraceMs = Number(opt("--shutdown-grace")[0] ?? 3) * 1000;
const seedVersions = (opt("--seed-version").length ? opt("--seed-version").map(Number) : [1, SCHEMA_VERSION - 1]).filter(
  (v, i, all) => v >= 1 && all.indexOf(v) === i,
);
const inputs = [zip, appArg, nsis, dirArg].filter(Boolean);
if (inputs.length !== 1) {
  console.error(
    "usage: smoke.ts (--zip <zip> | --app <Apollo.app> | --nsis <setup.exe> | --dir <win-unpacked>) [--seed-version <n>]... [--timeout <s>] [--app-arg <switch>]...",
  );
  process.exit(2);
}
const windows = Boolean(nsis || dirArg);
if (windows !== (process.platform === "win32")) {
  console.error(`${windows ? "--nsis/--dir need Windows" : "--zip/--app need macOS"} (this is ${process.platform})`);
  process.exit(2);
}
if (nsis && process.env.CI !== "true" && !args.includes("--allow-install")) {
  console.error("--nsis installs Apollo per-user (HKCU, Start menu) and uninstalls it afterwards: pass --allow-install outside CI");
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (command: string, argv: ReadonlyArray<string>, timeout = 10_000) => spawnSync(command, argv, { encoding: "utf8", timeout });

const root = mkdtempSync(join(tmpdir(), "apollo-smoke-"));
/** Where the app is: executable + resources directory. */
let executable = "";
let resources = "";
let uninstall: (() => void) | null = null;
/** Directories whose processes count as the app's: the bundle (or unpacked copy) or the install dir. */
const appDirs: Array<string> = [];
if (zip || appArg) {
  let app = appArg ? resolve(appArg) : "";
  if (zip) {
    const r = sh("ditto", ["-x", "-k", resolve(zip), join(root, "unpacked")], 300_000);
    if (r.status !== 0) throw new Error(`ditto -x -k failed: ${r.stderr}`);
    app = join(root, "unpacked", "Apollo.app");
  }
  const name = sh("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", join(app, "Contents", "Info.plist")]).stdout.trim() || "apollo";
  executable = join(app, "Contents", "MacOS", name);
  resources = join(app, "Contents", "Resources");
  appDirs.push(app, realpathSync(app));
} else {
  let dir = dirArg ? resolve(dirArg) : "";
  if (nsis) {
    // Started directly with verbatim `/S /D=<dir>`: no shell ever sees the paths (smoke-lib.ts).
    dir = join(root, "installed");
    console.log(`▸ installing ${nsis} silently into ${dir}`);
    const r = runSilentInstall((file, argv, options) => spawnSync(file, argv, { ...options, encoding: "utf8" }), resolve(nsis), dir);
    if (r.status !== 0) throw new Error(`the installer failed (${r.signal ?? `exit ${r.status}`}): ${r.stderr}`);
    const uninstaller = join(dir, "Uninstall Apollo.exe");
    uninstall = () => {
      if (!existsSync(uninstaller)) return console.log("  (no uninstaller found)");
      const u = spawnSync(uninstaller, ["/S"], { encoding: "utf8", timeout: 120_000 });
      console.log(`▸ uninstalled (exit ${u.status})`);
    };
  }
  executable = join(dir, "apollo.exe");
  resources = join(dir, "resources");
  appDirs.push(dir);
}
if (!existsSync(executable)) throw new Error(`no app executable at ${executable}`);
const info = JSON.parse(readFileSync(join(resources, "build-info.json"), "utf8")) as BuildInfo;
console.log(`▸ Smoke-testing ${info.version ?? "?"} (${info.commit.slice(0, 10)}, ${info.arch ?? "?"}, schema ${info.schemaVersion}) at ${executable}`);
const stampProblems: Array<string> = [];
if (process.env.APOLLO_BUILD_VERSION && info.version !== process.env.APOLLO_BUILD_VERSION) stampProblems.push(`build-info version ${info.version} != ${process.env.APOLLO_BUILD_VERSION}`);
if (process.env.APOLLO_BUILD_COMMIT && info.commit !== process.env.APOLLO_BUILD_COMMIT) stampProblems.push(`build-info commit ${info.commit} != ${process.env.APOLLO_BUILD_COMMIT}`);
if (info.schemaVersion !== SCHEMA_VERSION) {
  console.log(`  (this checkout's schema is ${SCHEMA_VERSION}; seeding with this checkout's migrations ${seedVersions.join(", ")})`);
}

/** Every process on the machine (ps on macOS, CIM on Windows); empty when the list can't be read. */
const listProcesses = (): Array<Proc> => {
  if (process.platform === "win32") {
    const r = sh(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"],
      30_000,
    );
    return r.status === 0 ? parseWinProcesses(r.stdout) : [];
  }
  const r = sh("ps", ["-axo", "pid=,ppid=,command="]);
  return r.status === 0 ? parsePs(r.stdout) : [];
};
/** The pids listening on a local TCP port. */
const portOwners = (port: number): Array<number> => {
  const r =
    process.platform === "win32"
      ? sh("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`], 30_000)
      : sh("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return (r.stdout ?? "").split(/\s+/).filter((t) => /^\d+$/.test(t)).map(Number);
};
const killTree = (pid: number) => {
  if (pid === process.pid) return;
  if (process.platform === "win32") sh("taskkill", ["/F", "/T", "/PID", String(pid)]);
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
/** Every pid descended from the app at any point of the run (the tree is lost once it exits). */
const tracked = new Set<number>();

const healthy = async (url: string) => {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return isHealthyResponse(response.status, await response.text());
  } catch {
    return false;
  }
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
  console.log(`▸ seed schema ${seedVersion} → app ${appArgs.join(" ")} (log ${logPath})`);
  const child = spawn(executable, appArgs, {
    cwd: home,
    stdio: ["ignore", log, log],
    env: smokeEnv(process.platform, process.env, launchEnv, {
      home,
      dataDir,
      userDataDir: join(dir, "electron"),
      screenshot,
      // Long enough for /health to be asked from outside before the app quits.
      screenshotDelayMs: 6000,
    }),
  });
  let exit: { code: number | null; signal: string | null } | null = null;
  const exited = new Promise<void>((r) => child.once("exit", (code, signal) => ((exit = { code, signal }), r())));
  const problems: Array<string> = [];
  const deadline = Date.now() + timeoutMs;
  let url: string | null = null;
  let answered = false;
  const sample = () => {
    if (exit || child.pid === undefined) return;
    for (const pid of descendantsOf(listProcesses(), child.pid)) tracked.add(pid);
  };
  if (child.pid !== undefined) tracked.add(child.pid);
  while (!answered && !exit && Date.now() < deadline) {
    sample();
    url ??= serverUrlFromLog(readFileSync(logPath, "utf8"));
    answered = url !== null && (await healthy(url));
    if (!answered) await sleep(250);
  }
  if (answered) console.log(`  /health answered at ${url}/health`);
  else if (exit) problems.push(`the app exited (${JSON.stringify(exit)}) before /health answered${url ? "" : " (no 'Listening on' line from the server)"}`);
  else problems.push(url ? `/health never answered at ${url}` : "the server never logged 'Listening on http://…'");
  while (!exit && Date.now() < deadline) {
    sample();
    await Promise.race([exited, sleep(250)]);
  }
  if (!exit) {
    problems.push(`the app did not exit within ${timeoutMs / 1000}s`);
    child.kill("SIGKILL");
    await exited;
  } else if ((exit as { code: number | null }).code !== 0) problems.push(`the app exited with ${JSON.stringify(exit)}`);
  // Nothing of the app may outlive it: no descendant, no process from its directory, and no
  // listener on its server's port (healthy or NOT), once the shutdown grace has passed.
  const port = url ? Number(new URL(url).port) : null;
  let leftovers: Array<Proc> = [];
  let listening = false;
  const settleBy = Date.now() + shutdownGraceMs;
  for (;;) {
    const procs = listProcesses();
    leftovers = procs.filter((p) => p.pid !== process.pid && (tracked.has(p.pid) || processesUnder([p], appDirs, process.platform).length > 0));
    listening = port !== null && (await portAccepts(port));
    if ((!leftovers.length && !listening) || Date.now() >= settleBy) break;
    await sleep(250);
  }
  if (leftovers.length) {
    problems.push(`processes still running ${shutdownGraceMs / 1000}s after the app exited: ${leftovers.map((p) => `${p.pid} (${p.command.slice(0, 160)})`).join("; ")}`);
  }
  if (listening) problems.push(`something still accepts connections on the server's port ${port} ${shutdownGraceMs / 1000}s after the app exited (pids ${portOwners(port!).join(", ") || "?"})`);
  // Clean up whatever survived, failure or not, so it can't leak into the next seed run.
  for (const pid of new Set([...leftovers.map((p) => p.pid), ...(listening ? portOwners(port!) : [])])) killTree(pid);
  if (!existsSync(screenshot) || statSync(screenshot).size === 0) problems.push("no window screenshot: the UI did not load");
  problems.push(...checkMigratedDatabase(dbPath, info.schemaVersion));
  if (problems.length) console.error(`--- app log (seed ${seedVersion}) ---\n${readFileSync(logPath, "utf8").slice(-8000)}\n---`);
  return problems.map((p) => `seed schema ${seedVersion}: ${p}`);
};

const failures: Array<string> = [...stampProblems];
try {
  for (const v of seedVersions) failures.push(...(await runOnce(v)));
} finally {
  for (const pid of tracked) if (alive(pid)) killTree(pid);
  uninstall?.();
  if (uninstall) {
    // After the uninstaller: nothing may still run from the install directory.
    await sleep(Math.min(shutdownGraceMs, 3000));
    const survivors = processesUnder(listProcesses(), appDirs, process.platform, new Set([process.pid]));
    if (survivors.length) failures.push(`processes still running from ${appDirs[0]} after uninstall: ${survivors.map((p) => `${p.pid} (${p.command.slice(0, 160)})`).join("; ")}`);
    for (const p of survivors) killTree(p.pid);
  }
  if (!process.env.APOLLO_SMOKE_KEEP) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
if (failures.length) {
  console.error(`✗ smoke test failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`✓ smoke test passed (seed schemas ${seedVersions.join(", ")} → ${info.schemaVersion})`);
