/**
 * Builds the desktop app and installs it in /Applications, as a local update.
 *
 *   pnpm install:app [--detach] [--now] [--wait-timeout <minutes>] [--force] [--dry-run] [--no-open]
 *
 * Nothing running is disturbed while it builds: the UI is built into build/web (not the
 * apps/web/dist a development run serves) and the app is staged next to the installed
 * one. If Apollo is running (installed, or a development run from this checkout), the swap
 * waits until no bot is in the middle of a turn, stops every Apollo process, snapshots the
 * database, moves the new app in and opens it until its server answers /health and keeps
 * answering. If it does not, the previous app and the database snapshot go back and that is
 * opened instead. See install-app-engine.ts for the state machine and its guarantees.
 *
 *   --detach            run in the background, detached from this terminal or session, logging to
 *                       ~/.apollo/logs/install-app-<epoch>.log (what a bot updating Apollo should use:
 *                       its turn can end, so it no longer counts as busy)
 *   --now               don't wait for running turns (they are stopped)
 *   --wait-timeout <m>  give up after m minutes (default 120) if bots are still busy; the app is untouched
 *   --force             install even if the database is newer than this code (a downgrade)
 *   --dry-run           print what would happen; writes nothing anywhere (implies no --detach)
 *   --no-open           don't open Apollo afterwards (the previous app is then kept)
 *
 * One install runs at a time (~/.apollo/install-app.lock). The outcome is always written to
 * ~/.apollo/logs/install-app-last.result (JSON), so it can be checked after Apollo restarts.
 * An install that did not finish (~/.apollo/install-app.pending.json, or no Apollo.app) is
 * finished or undone by the next run before anything else.
 *
 * Signing: the first "Apple Development" identity in the keychain (or APOLLO_SIGN_IDENTITY),
 * so macOS keeps permissions such as the microphone across updates. Without one the app
 * is signed ad hoc, and macOS asks for those permissions again after each update.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION } from "../../server/src/Database.ts";
import { runInstall, TIMING, type Deps, type Proc } from "./install-app-engine.ts";
import {
  BUNDLES,
  checkSchema,
  childArgs,
  healthUrls,
  isHealthyResponse,
  lockHolder,
  parseArgs,
  plan,
  readMarker,
  realFileOps,
  realSqliteOps,
  type BuildInfo,
} from "./install-app-lib.ts";

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
const repoRoot = resolve(desktopDir, "../..");
const { target, staged } = BUNDLES;
const dataDir = process.env.APOLLO_DATA_DIR ?? join(homedir(), ".apollo");
const dbPath = join(dataDir, "apollo.db");
const logsDir = join(dataDir, "logs");
const lockPath = join(dataDir, "install-app.lock");
const markerPath = join(dataDir, "install-app.pending.json");
const resultPath = join(logsDir, "install-app-last.result");
const BUNDLE_ID = "dev.apollo.desktop";

const log = (line: string) => console.log(line);

// ---------------------------------------------------------------------------------------
// Processes

/**
 * Every process. Throws when `ps` fails or shows nothing (it always shows at least itself and
 * this script): a list that could not be read must never pass for "nothing is running".
 */
const processes = () => {
  const r = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 10_000 });
  if (r.error) throw new Error(`ps failed: ${r.error.message}`);
  if (r.status !== 0 || r.signal) throw new Error(`ps failed (${r.signal ?? `exit ${r.status}`}): ${(r.stderr ?? "").trim()}`);
  const list = (r.stdout ?? "").split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), command: match[2]! }] : [];
  });
  if (!list.some((p) => p.pid === process.pid)) throw new Error("ps returned an incomplete process list");
  return list;
};

const bundlePaths = Object.values(BUNDLES);

/**
 * Every Apollo process: the app from any of its bundle paths, its servers (whatever runtime
 * runs server.mjs, APOLLO_NODE included), and development runs of this checkout.
 */
const apolloProcesses = (): Array<Proc> =>
  processes().flatMap(({ pid, command }): Array<Proc> => {
    if (pid === process.pid) return [];
    if (bundlePaths.some((b) => command.includes(`${b}/Contents/Resources/server/server.mjs`))) return [{ pid, kind: "server" }];
    if (command.includes(`${repoRoot}/apps/server/src/bin.ts`)) return [{ pid, kind: "server" }];
    if (bundlePaths.some((b) => command.startsWith(`${b}/Contents/MacOS/`))) return [{ pid, kind: "installed" }];
    if (/Electron\.app\/Contents\/MacOS\/Electron \.$/.test(command) && command.includes(repoRoot)) return [{ pid, kind: "development" }];
    return [];
  });

/** Whether `pid` is a running install:app; throws when that cannot be told (the lock then counts as held). */
const isInstaller = (pid: number): boolean => {
  const exists = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ESRCH: no such process. EPERM: another user's process, so not this user's installer.
      if (code === "ESRCH" || code === "EPERM") return false;
      throw error;
    }
  };
  if (!exists()) return false;
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
  if (!r.error && r.status === 0 && !r.signal) return r.stdout.includes("install-app.ts");
  // ps -p exits 1 for a pid that just went away; anything else is "cannot tell".
  if (!r.error && r.status === 1 && !exists()) return false;
  throw new Error(`cannot tell whether pid ${pid} is install:app: ${r.error?.message ?? r.signal ?? `ps exit ${r.status}`}`);
};

/** Sessions mid-turn (or waiting on the user) in a database. */
const busySessions = (path: string): Array<string> => {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
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

/**
 * The packaged app starts its server on a free port it picks at launch (apps/desktop/src/main.ts)
 * and hands it over as APOLLO_PORT (apps/server/src/Config.ts). Ask the installed app's servers
 * on that port, only if they really listen there (lsof), else on their loopback ports.
 */
const healthy = async (): Promise<boolean> => {
  for (const { pid, command } of processes()) {
    if (!command.includes(`${target}/Contents/Resources/server/server.mjs`)) continue;
    const env = spawnSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "";
    const lsof = spawnSync("lsof", ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n"], { encoding: "utf8" }).stdout ?? "";
    for (const url of healthUrls(env, lsof)) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (isHealthyResponse(response.status, await response.text())) return true;
      } catch {
        // not up yet
      }
    }
  }
  return false;
};

// ---------------------------------------------------------------------------------------
// --dry-run: reads only. SQLite may create a -shm next to a database it opens, even read-only,
// so the database is read from a copy in a temporary directory.

if (options.dryRun) {
  if (options.detach) log("(--dry-run runs in the foreground: --detach ignored)");
  const scratch = mkdtempSync(join(tmpdir(), "install-app-dry-"));
  try {
    const copy = join(scratch, "apollo.db");
    if (existsSync(dbPath)) {
      copyFileSync(dbPath, copy);
      if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${copy}-wal`);
    }
    const state = realSqliteOps.inspect(copy);
    const procs = (() => {
      try {
        return apolloProcesses();
      } catch (error) {
        log(`(${(error as Error).message})`);
        return null;
      }
    })();
    const steps = plan({
      options,
      targetExists: existsSync(target),
      previousExists: existsSync(BUNDLES.previous),
      marker: readMarker(markerPath),
      lock: lockHolder(lockPath, isInstaller),
      running: procs?.map((p) => `${p.kind} ${p.pid}`) ?? null,
      busy: (() => {
        try {
          return busySessions(copy);
        } catch (error) {
          return [`(could not read sessions: ${(error as Error).message})`];
        }
      })(),
      schema: checkSchema(state?.version ?? null, SCHEMA_VERSION, options.force),
      bundles: BUNDLES,
      hasDb: state !== null,
      backupsDir: join(dataDir, "backups"),
    });
    log("\n▸ Dry run: nothing is built, stopped, moved or written");
    steps.forEach((line, i) => log(`  ${i + 1}. ${line}`));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------------------
// --detach: start this script again in its own session, and return at once

if (options.detach) {
  const held = lockHolder(lockPath, isInstaller);
  if (held) {
    console.error(
      held.state === "alive"
        ? `Another install:app (pid ${held.holder?.pid}, started ${held.holder?.startedAt}) is running; not starting a second one.`
        : `The install lock (${lockPath}) is held by pid ${held.holder?.pid ?? "?"} and whether it still runs cannot be told; not starting.`,
    );
    process.exit(1);
  }
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, `install-app-${Math.floor(Date.now() / 1000)}.log`);
  const fd = openSync(logPath, "a");
  // detached: a new session and process group (setsid), so neither the terminal nor the
  // session that ran this, nor Apollo quitting, takes it down with them. The child takes the lock.
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

// ---------------------------------------------------------------------------------------
// The install, with the real effects

const run = (command: string, args: Array<string>, env: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync(command, args, { cwd: desktopDir, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
};

const build = async (): Promise<BuildInfo> => {
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
  const info = JSON.parse(readFileSync(join(built, "Contents", "Resources", "build-info.json"), "utf8")) as BuildInfo;
  log(`  Built ${info.commit.slice(0, 10)}${info.dirty ? " (dirty)" : ""} on ${info.branch ?? "?"}, schema ${info.schemaVersion}`);
  log(`  Staging ${built} → ${staged}`);
  rmSync(staged, { recursive: true, force: true });
  run("ditto", [built, staged]);
  return info;
};

let holding = false;
const deps: Deps = {
  env: {
    bundles: BUNDLES,
    dbPath,
    backupsDir: join(dataDir, "backups"),
    markerPath,
    lockPath,
    resultPath,
    logPath: process.env.APOLLO_INSTALL_LOG ?? null,
    codeSchema: SCHEMA_VERSION,
    options,
    pid: process.pid,
    timing: TIMING,
  },
  files: realFileOps,
  sqlite: realSqliteOps,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log,
  apollo: apolloProcesses,
  requestQuit: (procs) => {
    if (procs.some((p) => p.kind === "installed")) {
      // Bounded: an Apple event to an app that does not answer can block for minutes.
      const r = spawnSync("osascript", ["-e", `tell application id "${BUNDLE_ID}" to quit`], { timeout: 10_000 });
      if (r.error || r.status !== 0) log(`  (osascript: ${r.error?.message ?? `exit ${r.status}`})`);
    }
    for (const p of procs.filter((p) => p.kind === "development")) {
      try {
        process.kill(p.pid, "SIGTERM");
      } catch {
        // gone
      }
    }
  },
  kill: (pid) => process.kill(pid, "SIGKILL"),
  isInstaller,
  busy: () => busySessions(dbPath),
  build,
  open: () => {
    const r = spawnSync("open", ["-a", target], { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) log(`  open failed (${r.status}): ${(r.stderr ?? "").trim()}`);
  },
  healthy,
  holdSignals: () => {
    if (holding) return;
    holding = true;
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
      process.on(signal, () => log(`  (${signal} ignored: the install is under way)`));
    }
  },
};

const result = await runInstall(deps);
process.exit(result.status === "ok" ? 0 : 1);
