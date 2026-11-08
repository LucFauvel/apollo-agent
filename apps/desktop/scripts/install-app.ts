/**
 * Builds the desktop app and installs it in /Applications, as a local update.
 *
 *   pnpm install:app [--detach] [--now] [--wait-timeout <minutes>] [--force] [--dry-run] [--no-open]
 *
 * Nothing running is disturbed while it builds: the UI is built into build/web (not the
 * apps/web/dist a development run serves) and the app is staged next to the installed
 * one. If Apollo is running (installed, or a development run), the swap waits until no
 * bot is in the middle of a turn, then quits Apollo, moves the new app in and opens it
 * until its server answers /health. The previous app is kept until then; if the new one
 * never gets healthy, the previous one is put back and opened instead.
 *
 *   --detach            run in the background, detached from this terminal or session, logging to
 *                       ~/.apollo/logs/install-app-<epoch>.log (what a bot updating Apollo should use:
 *                       its turn can end, so it no longer counts as busy)
 *   --now               don't wait for running turns (they are stopped)
 *   --wait-timeout <m>  give up after m minutes (default 120) if bots are still busy; the app is untouched
 *   --force             install even if the database is newer than this code (a downgrade)
 *   --dry-run           print what would happen; build, quit and move nothing
 *   --no-open           don't open Apollo afterwards (the previous app is then kept)
 *
 * The outcome is always written to ~/.apollo/logs/install-app-last.result (JSON), so it
 * can be checked after Apollo restarts. If an interrupted install left no Apollo.app but a
 * .Apollo-previous.app, the next run puts that back first and stops there.
 *
 * Signing: the first "Apple Development" identity in the keychain (or APOLLO_SIGN_IDENTITY),
 * so macOS keeps permissions such as the microphone across updates. Without one the app
 * is signed ad hoc, and macOS asks for those permissions again after each update.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION } from "../../server/src/Database.ts";
import {
  BUNDLES,
  checkSchema,
  childArgs,
  isHealthyResponse,
  parseArgs,
  plan,
  portFromPsEnv,
  portsFromLsof,
  readDbVersion,
  recoverIfNeeded,
  relaunchUntilHealthy,
  swapAndVerify,
  waitForIdle,
  writeResult,
  type BuildInfo,
  type BundleFs,
  type InstallResult,
  type ResultStatus,
} from "./install-app-lib.ts";
import { describe } from "./write-build-info.ts";

if (process.platform !== "darwin") {
  console.error("install:app is for macOS. Use `pnpm package` for installers on other systems.");
  process.exit(1);
}

const argv = process.argv.slice(2);
const options = (() => {
  try {
    return parseArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    return process.exit(2);
  }
})();
const scriptPath = fileURLToPath(import.meta.url);
const desktopDir = resolve(dirname(scriptPath), "..");
const { target, staged, previous } = BUNDLES;
const dataDir = process.env.APOLLO_DATA_DIR ?? join(homedir(), ".apollo");
const dbPath = join(dataDir, "apollo.db");
const logsDir = join(dataDir, "logs");
const resultPath = join(logsDir, "install-app-last.result");
const BUNDLE_ID = "dev.apollo.desktop";
const RELAUNCH_TIMEOUT_MS = 2 * 60_000;

// ---------------------------------------------------------------------------------------
// --detach: start this script again in its own session, and return at once

if (options.detach) {
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, `install-app-${Math.floor(Date.now() / 1000)}.log`);
  const fd = openSync(logPath, "a");
  // detached: a new session and process group (setsid), so neither the terminal nor the
  // session that ran this, nor Apollo quitting, takes it down with them.
  const child = spawn(process.execPath, [scriptPath, ...childArgs(argv)], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, APOLLO_INSTALL_LOG: logPath },
  });
  child.unref();
  console.log(`install:app is running in the background (pid ${child.pid}).`);
  console.log(`  log:    ${logPath}`);
  console.log(`  result: ${resultPath}`);
  process.exit(0);
}

const log = (line: string) => console.log(line);
const step = (message: string) => console.log(`\n▸ ${message}  [${new Date().toISOString()}]`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const run = (command: string, args: Array<string>, env: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync(command, args, { cwd: desktopDir, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
};

const realFs: BundleFs = {
  exists: existsSync,
  rename: (from, to) => {
    log(`  mv ${from} ${to}`);
    renameSync(from, to);
  },
  remove: (path) => {
    if (!existsSync(path)) return;
    log(`  rm -rf ${path}`);
    rmSync(path, { recursive: true, force: true });
  },
};

// ---------------------------------------------------------------------------------------
// Processes, turns and health

type Running = { pid: number; kind: "installed" | "development" };

const processes = () =>
  spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    .stdout.split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match ? [{ pid: Number(match[1]), command: match[2]! }] : [];
    });

/** Main processes of Apollo: the installed app and development runs from this checkout. */
const runningApollo = (): Array<Running> =>
  processes().flatMap(({ pid, command }): Array<Running> => {
    if (command.startsWith(`${target}/Contents/MacOS/`) && !command.includes("server.mjs")) return [{ pid, kind: "installed" }];
    if (/Electron\.app\/Contents\/MacOS\/Electron \.$/.test(command) && command.includes(desktopDir.replace(/apps\/desktop$/, ""))) {
      return [{ pid, kind: "development" }];
    }
    return [];
  });

/** Apollo servers (installed bundle or development sources), to make sure they stop. */
const serverPids = () =>
  processes()
    .filter(({ command }) => /Apollo\.app\/Contents\/Resources\/server\/server\.mjs|apps\/server\/src\/bin\.ts/.test(command))
    .map(({ pid }) => pid);

/** Servers of the installed app: the Electron binary running Resources/server/server.mjs. */
const installedServerPids = () =>
  processes()
    .filter(({ command }) => command.startsWith(`${target}/Contents/MacOS/`) && command.includes(`${target}/Contents/Resources/server/server.mjs`))
    .map(({ pid }) => pid);

/** Sessions mid-turn (or waiting on the user) in Apollo's database. */
const busySessions = (): Array<string> => {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("pragma busy_timeout = 3000");
    const rows = db
      .prepare(
        `select s.id, s.title, s.status, b.name as bot from sessions s left join bots b on b.id = s.bot_id
         where s.status in ('starting', 'running', 'waiting-approval')`,
      )
      .all() as Array<{ id: string; title: string; status: string; bot: string | null }>;
    return rows.map((r) => `${r.bot ?? "?"} / ${r.title} (${r.status}, ${r.id})`);
  } finally {
    db.close();
  }
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The packaged app starts its server on a free port it picks at launch (apps/desktop/src/main.ts)
 * and hands it over as APOLLO_PORT (apps/server/src/Config.ts). Read it from the server's
 * environment; failing that, try the loopback ports it listens on.
 */
const serverPorts = (pid: number): Array<number> => {
  const env = spawnSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "";
  const port = portFromPsEnv(env);
  if (port !== null) return [port];
  return portsFromLsof(spawnSync("lsof", ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n"], { encoding: "utf8" }).stdout ?? "");
};

let lastHealthUrl: string | null = null;
const healthy = async (): Promise<boolean> => {
  for (const pid of installedServerPids()) {
    for (const port of serverPorts(pid)) {
      const url = `http://127.0.0.1:${port}/health`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (isHealthyResponse(response.status, await response.text())) {
          if (lastHealthUrl !== url) log(`  ${url} answers (server pid ${pid})`);
          lastHealthUrl = url;
          return true;
        }
      } catch {
        // not up yet
      }
    }
  }
  return false;
};

const openApp = () => {
  const result = spawnSync("open", ["-a", target], { encoding: "utf8" });
  if (result.status !== 0) log(`  open failed (${result.status}): ${(result.stderr ?? "").trim()}`);
};

const relaunch = () => relaunchUntilHealthy({ open: openApp, healthy, sleep, now: Date.now, log, timeoutMs: RELAUNCH_TIMEOUT_MS });

/** Quits the given apps (and every Apollo server), force-stopping what is left after `graceMs`. */
const quit = async (running: ReadonlyArray<Running>, graceMs: number) => {
  const servers = serverPids();
  for (const app of running) {
    if (app.kind === "installed") spawnSync("osascript", ["-e", `tell application id "${BUNDLE_ID}" to quit`]);
    else process.kill(app.pid, "SIGTERM");
  }
  // Give the server time to stop its agents and local models cleanly.
  const pids = [...running.map((r) => r.pid), ...servers];
  for (let waited = 0; waited < graceMs && pids.some(isAlive); waited += 500) await sleep(500);
  for (const pid of pids.filter(isAlive)) {
    log(`  Process ${pid} did not exit: stopping it`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone in the meantime
    }
  }
  for (let i = 0; i < 20 && pids.some(isAlive); i++) await sleep(250);
};

/** From the quit onward, being stopped halfway would leave no app: ignore the usual signals. */
const holdSignals = () => {
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(signal, () => log(`  (${signal} ignored: the install is swapping bundles)`));
  }
};

// ---------------------------------------------------------------------------------------
// Result file

const startedAt = new Date().toISOString();
let stage = "start";
let build: BuildInfo | null = null;
const record = (status: ResultStatus, error: string | null = null) => {
  const result: InstallResult = {
    status,
    stage,
    build,
    startedAt,
    finishedAt: status === "running" ? null : new Date().toISOString(),
    error,
    log: process.env.APOLLO_INSTALL_LOG ?? null,
    pid: process.pid,
  };
  if (!options.dryRun) writeResult(resultPath, result);
};
function finish(status: Exclude<ResultStatus, "running">, error: string | null = null): never {
  record(status, error);
  const mark = status === "ok" ? "✓" : "✗";
  log(`\n${mark} install:app ${status} at stage "${stage}"${error ? `: ${error}` : ""}`);
  if (build) log(`  build: ${describe(build)}`);
  log(`  result: ${resultPath}`);
  process.exit(status === "ok" ? 0 : 1);
}

// ---------------------------------------------------------------------------------------
// Dry run

if (options.dryRun) {
  const schema = checkSchema(readDbVersion(dbPath), SCHEMA_VERSION, options.force);
  step("Dry run: nothing is built, quit or moved");
  const steps = plan({
    options,
    targetExists: existsSync(target),
    previousExists: existsSync(previous),
    running: runningApollo().map((r) => `${r.kind} pid ${r.pid}`),
    busy: (() => {
      try {
        return busySessions();
      } catch (error) {
        return [`(could not read sessions: ${(error as Error).message})`];
      }
    })(),
    schema,
    bundles: BUNDLES,
  });
  steps.forEach((line, i) => log(`  ${i + 1}. ${line}`));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------
// The install

try {
  record("running");

  // An earlier install stopped between two renames: put the previous app back, and stop.
  if (recoverIfNeeded(realFs, BUNDLES)) {
    stage = "recovery";
    step(`Recovery: ${target} was missing; restored it from ${previous}`);
    const ok = options.noOpen || (await relaunch());
    finish(ok ? "rolled-back" : "failed", ok ? "Restored the previous app after an interrupted install; run install:app again to update" : "Restored the previous app, but it does not answer /health");
  }

  stage = "db-check";
  const schema = checkSchema(readDbVersion(dbPath), SCHEMA_VERSION, options.force);
  if (!schema.ok) finish("aborted", schema.message);
  log(`Database: ${schema.note}`);

  // 1. Build
  stage = "build";
  step("Building Apollo (the running app is not touched)");
  const signingIdentity = (): string | null => {
    if (process.env.APOLLO_SIGN_IDENTITY) return process.env.APOLLO_SIGN_IDENTITY;
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    return /"Apple Development: ([^"]+)"/.exec(out)?.[1] ?? null;
  };
  // The pnpm that launched this script (it may not be on PATH).
  const execPath = process.env.npm_execpath;
  const pnpm = !execPath ? ["pnpm"] : /\.[cm]?js$/.test(execPath) ? [process.execPath, execPath] : [execPath];
  run(pnpm[0]!, [...pnpm.slice(1), "build:package"]);
  const identity = signingIdentity();
  log(identity ? `  Signing as Apple Development: ${identity}` : "  No Apple Development identity: signing ad hoc");
  run(
    "npx",
    [
      "electron-builder",
      "--dir",
      "--publish",
      "never",
      // A local build is not notarized; the hardened runtime would only add entitlements to manage.
      "-c.mac.hardenedRuntime=false",
      ...(identity ? [`-c.mac.identity=${identity}`] : ["-c.mac.identity=null"]),
    ],
    identity ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  );
  const releaseDir = join(desktopDir, "release");
  const built = readdirSync(releaseDir)
    .filter((d) => d.startsWith("mac"))
    .map((d) => join(releaseDir, d, "Apollo.app"))
    .find((p) => existsSync(p));
  if (!built) throw new Error(`No Apollo.app under ${releaseDir}`);
  build = JSON.parse(readFileSync(join(built, "Contents", "Resources", "build-info.json"), "utf8")) as BuildInfo;
  log(`  Built ${describe(build)}`);

  stage = "stage";
  step(`Staging ${built} → ${staged}`);
  rmSync(staged, { recursive: true, force: true });
  run("ditto", [built, staged]);
  record("running");

  // 2. Wait for running turns, then quit Apollo
  const running = runningApollo();
  if (running.length > 0) {
    step(`Apollo is running (${running.map((r) => r.kind).join(", ")})`);
    if (!options.now) {
      stage = "wait-idle";
      record("running");
      const idle = await waitForIdle({ busy: busySessions, sleep, now: Date.now, log, timeoutMs: options.waitTimeoutMs });
      if (!idle.idle) {
        realFs.remove(staged);
        finish("aborted", `Bots still busy after ${options.waitTimeoutMs / 60_000} min, Apollo left as it was: ${idle.busy.join("; ")}`);
      }
      log("  No bot is working: updating now.");
    }
    // The schema may have moved on while this waited (another install, a development run).
    const again = checkSchema(readDbVersion(dbPath), SCHEMA_VERSION, options.force);
    if (!again.ok) {
      realFs.remove(staged);
      finish("aborted", again.message);
    }

    stage = "quit";
    holdSignals();
    record("running");
    step("Quitting Apollo");
    await quit(running, 30_000);
  } else {
    holdSignals();
  }

  // 3. Swap, open until healthy, roll back if not
  stage = "swap";
  record("running");
  step(`Installing ${target}`);
  const outcome = await swapAndVerify({
    fs: realFs,
    bundles: BUNDLES,
    relaunch: async () => {
      stage = "relaunch";
      record("running");
      step(`Opening Apollo until it answers /health (up to ${RELAUNCH_TIMEOUT_MS / 60_000} min)`);
      return relaunch();
    },
    stopApp: async () => {
      stage = "rollback";
      record("running");
      step("Stopping the new build and restoring the previous one");
      await quit(runningApollo(), 10_000);
    },
    log,
    open: !options.noOpen,
  });
  stage = outcome.stage;
  if (outcome.status === "ok") finish("ok");
  finish(outcome.status, outcome.error);
} catch (error) {
  // Never leave the Mac without an Apollo.app.
  try {
    if (recoverIfNeeded(realFs, BUNDLES)) log(`  Put ${previous} back as ${target}`);
  } catch (restoreError) {
    log(`  Could not restore ${previous}: ${String(restoreError)}`);
  }
  finish("failed", error instanceof Error ? error.message : String(error));
}
