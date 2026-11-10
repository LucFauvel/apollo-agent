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
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION } from "../../../server/src/Database.ts";
import { isHealthyResponse, launchEnv, type BuildInfo } from "../install-app-lib.ts";
import {
  checkMigratedDatabase,
  type CommandResult,
  descendantsOf,
  isNsisUninstaller,
  isTracked,
  portAccepts,
  processesUnder,
  type ProcessList,
  readProcessList,
  runSilentInstall,
  seedOldDatabase,
  serverUrlFromLog,
  smokeEnv,
  survivorVerdict,
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
/**
 * How long the app keeps its window up before capturing and quitting (APOLLO_SCREENSHOT_DELAY):
 * long enough for /health to be asked from outside AND for at least one process-tree sample to
 * finish while it runs. Get-CimInstance takes many seconds on the hosted Windows arm64 runner,
 * hence the larger Windows default.
 */
const screenshotDelayMs = Number(opt("--screenshot-delay")[0] ?? (process.platform === "win32" ? 30 : 6)) * 1000;
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
/**
 * Like `sh`, but without blocking the event loop: while a slow PowerShell runs, /health keeps
 * being polled and the app's exit is still seen. (A blocking spawnSync here is what made the
 * Windows arm64 smoke miss /health entirely: the app served, captured and quit while the
 * harness sat in Get-CimInstance.)
 */
const shAsync = (command: string, argv: ReadonlyArray<string>, timeout: number): Promise<CommandResult> =>
  new Promise((done) => {
    const child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      done({ status: null, signal: null, stdout, stderr, error });
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      done(
        timedOut
          ? { status, signal, stdout, stderr, error: Object.assign(new Error(`${command} ETIMEDOUT after ${timeout / 1000}s`), { code: "ETIMEDOUT" }) }
          : { status, signal, stdout, stderr },
      );
    });
  });

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

/**
 * Every process on the machine (ps on macOS, CIM on Windows), or why it couldn't be read: an
 * unreadable list is never taken for an empty one (readProcessList, survivorVerdict). CIM is slow
 * and occasionally times out on hosted runners: a generous timeout and ONE retry before the list
 * counts as unreadable (which still fails closed).
 */
const listTimeoutMs = process.platform === "win32" ? 90_000 : 10_000;
const listOnce = async (): Promise<ProcessList> =>
  readProcessList(
    process.platform,
    process.platform === "win32"
      ? await shAsync(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"],
          listTimeoutMs,
        )
      : await shAsync("ps", ["-axo", "pid=,ppid=,command="], listTimeoutMs),
    process.pid,
  );
const listProcesses = async (): Promise<ProcessList> => {
  const first = await listOnce();
  if (first.ok) return first;
  console.log(`  (process list unreadable, retrying once: ${first.error})`);
  return listOnce();
};
/** Files under a directory (0 once it is gone), for progress reporting only. */
const countFiles = (dir: string): number => {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
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
const tracked = new Map<number, string | null>();

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
      screenshotDelayMs,
    }),
  });
  let exit: { code: number | null; signal: string | null } | null = null;
  const exited = new Promise<void>((r) => child.once("exit", (code, signal) => ((exit = { code, signal }), r())));
  const problems: Array<string> = [];
  const deadline = Date.now() + timeoutMs;
  let url: string | null = null;
  let answered = false;
  // The app's process tree, sampled while it runs, CONCURRENTLY with the /health polling (a
  // sample can take seconds on Windows). Only a sample that finished while the app was still
  // running counts: one that completed after its exit may have missed descendants. If no sample
  // ever counted, a detached descendant could go unseen: that fails the run (unknown is not none).
  let samples = 0;
  let sampleError: string | null = null;
  const sampleTimes: Array<number> = [];
  const sampler = (async () => {
    while (!exit && child.pid !== undefined && Date.now() < deadline) {
      const started = performance.now();
      const list = await listProcesses();
      sampleTimes.push(Math.round(performance.now() - started));
      if (exit) break;
      if (list.ok) {
        samples++;
        const ids = new Set([child.pid, ...descendantsOf(list.procs, child.pid)]);
        for (const p of list.procs) if (ids.has(p.pid) && !tracked.has(p.pid)) tracked.set(p.pid, p.command);
      } else sampleError = list.error;
      await Promise.race([exited, sleep(250)]);
    }
  })();
  if (child.pid !== undefined) tracked.set(child.pid, null);
  while (!answered && !exit && Date.now() < deadline) {
    url ??= serverUrlFromLog(readFileSync(logPath, "utf8"));
    answered = url !== null && (await healthy(url));
    if (!answered) await Promise.race([exited, sleep(250)]);
  }
  if (answered) console.log(`  /health answered at ${url}/health`);
  else if (exit) problems.push(`the app exited (${JSON.stringify(exit)}) before /health answered${url ? "" : " (no 'Listening on' line from the server)"}`);
  else problems.push(url ? `/health never answered at ${url}` : "the server never logged 'Listening on http://…'");
  await Promise.race([exited, sleep(Math.max(0, deadline - Date.now()))]);
  if (!exit) {
    problems.push(`the app did not exit within ${timeoutMs / 1000}s`);
    child.kill("SIGKILL");
    await exited;
  } else if ((exit as { code: number | null }).code !== 0) problems.push(`the app exited with ${JSON.stringify(exit)}`);
  // Nothing of the app may outlive it: no descendant, no process from its directory, and no
  // listener on its server's port (healthy or NOT), once the shutdown grace has passed. An
  // unreadable process list never counts as "nothing left" (survivorVerdict fails closed).
  await sampler;
  console.log(`  process-tree samples: ${samples} while it ran (list times ms: ${sampleTimes.join(", ") || "none"}); app exit ${JSON.stringify(exit)}`);
  if (samples === 0) problems.push(`could not read the app's process tree while it ran (${sampleError ?? "no sample taken"}): its descendants can't be checked`);
  const port = url ? Number(new URL(url).port) : null;
  const settleBy = Date.now() + shutdownGraceMs;
  let verdict: ReturnType<typeof survivorVerdict>;
  let listening = false;
  for (;;) {
    listening = port !== null && (await portAccepts(port));
    verdict = survivorVerdict({
      list: await listProcesses(),
      tracked,
      isAlive: alive,
      appDirs,
      platform: process.platform,
      selfPid: process.pid,
      listening,
      port,
      graceSeconds: shutdownGraceMs / 1000,
    });
    if (verdict.clean || Date.now() >= settleBy) break;
    await sleep(250);
  }
  problems.push(...verdict.problems);
  // Clean up whatever survived, failure or not, so it can't leak into the next seed run.
  for (const pid of new Set([...verdict.kill, ...(listening ? portOwners(port!) : [])])) killTree(pid);
  if (!existsSync(screenshot) || statSync(screenshot).size === 0) problems.push("no window screenshot: the UI did not load");
  problems.push(...checkMigratedDatabase(dbPath, info.schemaVersion));
  if (problems.length) console.error(`--- app log (seed ${seedVersion}) ---\n${readFileSync(logPath, "utf8").slice(-8000)}\n---`);
  return problems.map((p) => `seed schema ${seedVersion}: ${p}`);
};

const failures: Array<string> = [...stampProblems];
try {
  // Warm-up, and a measure of how slow the process list is on this machine (CIM on hosted
  // Windows runners can take tens of seconds): logged so a failing run says why.
  const warmStart = performance.now();
  const warm = await listProcesses();
  console.log(`▸ process list ${warm.ok ? `read (${warm.procs.length} processes)` : `UNREADABLE (${warm.error})`} in ${Math.round(performance.now() - warmStart)}ms`);
  for (const v of seedVersions) failures.push(...(await runOnce(v)));
} finally {
  // Kill what is left of the app, but never a process that merely reuses one of its pids.
  const last = await listProcesses();
  for (const pid of last.ok ? last.procs.filter((p) => p.pid !== process.pid && isTracked(tracked, p)).map((p) => p.pid) : [...tracked.keys()].filter(alive)) killTree(pid);
  uninstall?.();
  if (uninstall) {
    // The NSIS uninstaller copies itself to %TEMP%\~nsuX.tmp\Un_X.exe and relaunches with
    // `_?=<install dir>`: "Uninstall Apollo.exe" returns while that copy still deletes files, which
    // takes minutes on the hosted arm64 runner (its silent install takes ~4). Wait, bounded, for it
    // to exit before judging what is left in the install directory: identified once from the (slow)
    // process list, then polled cheaply by pid, logging how many files remain (slow vs. stuck).
    const uninstallWaitMs = 600_000;
    const startedWaiting = Date.now();
    const first = await listProcesses();
    let pending = first.ok ? processesUnder(first.procs, appDirs, process.platform, new Set([process.pid])).filter(isNsisUninstaller).map((p) => p.pid) : [];
    let lastReport = 0;
    while (pending.length && Date.now() - startedWaiting < uninstallWaitMs) {
      if (Date.now() - lastReport >= 30_000) {
        lastReport = Date.now();
        console.log(`  waiting for the NSIS uninstaller (${pending.join(", ")}): ${countFiles(appDirs[0]!)} files left in the install directory after ${Math.round((Date.now() - startedWaiting) / 1000)}s`);
      }
      await sleep(1000);
      pending = pending.filter(alive);
    }
    if (pending.length) failures.push(`the NSIS uninstaller was still running ${uninstallWaitMs / 1000}s after "Uninstall Apollo.exe" returned: ${pending.join(", ")} (${countFiles(appDirs[0]!)} files left)`);
    else console.log(`▸ uninstaller finished after ${Math.round((Date.now() - startedWaiting) / 1000)}s (${countFiles(appDirs[0]!)} files left)`);
    // After the uninstaller: nothing may still run from the install directory.
    await sleep(Math.min(shutdownGraceMs, 3000));
    const list = await listProcesses();
    if (!list.ok) failures.push(`could not list processes after uninstall (${list.error}): cannot confirm nothing runs from ${appDirs[0]}`);
    const survivors = list.ok ? processesUnder(list.procs, appDirs, process.platform, new Set([process.pid])) : [];
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
