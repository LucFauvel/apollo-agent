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
 *  5. the app must exit 0 within the timeout, the port must stop answering (no server left
 *     behind), a non-empty PNG must exist, and the database must be at build-info's
 *     schemaVersion with the seed intact. With APOLLO_BUILD_VERSION/APOLLO_BUILD_COMMIT set, the
 *     app's build-info.json must carry them.
 *
 * What it does NOT cover (see RELEASE-SETUP.md): the tray, a visible window, an `open` launch
 * through LaunchServices/Gatekeeper or SmartScreen, provider CLIs (none on CI) and the tailnet
 * (not enabled in a fresh data dir). It runs the real packaged binary, not a simulation.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION } from "../../../server/src/Database.ts";
import { isHealthyResponse, launchEnv, type BuildInfo } from "../install-app-lib.ts";
import { checkMigratedDatabase, seedOldDatabase, serverUrlFromLog, smokeEnv } from "./smoke-lib.ts";

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
} else {
  let dir = dirArg ? resolve(dirArg) : "";
  if (nsis) {
    // NSIS wants /D= last and unquoted: build the command line by hand (the temp path has no spaces on CI).
    dir = join(root, "installed");
    if (dir.includes(" ")) throw new Error(`the install directory must not contain spaces: ${dir}`);
    console.log(`▸ installing ${nsis} silently into ${dir}`);
    const r = spawnSync(`"${resolve(nsis)}" /S /D=${dir}`, { shell: true, encoding: "utf8", timeout: 300_000 });
    if (r.status !== 0) throw new Error(`the installer failed (${r.signal ?? `exit ${r.status}`}): ${r.stderr}`);
    const uninstaller = join(dir, "Uninstall Apollo.exe");
    uninstall = () => {
      if (!existsSync(uninstaller)) return console.log("  (no uninstaller found)");
      const u = spawnSync(`"${uninstaller}" /S`, { shell: true, encoding: "utf8", timeout: 120_000 });
      console.log(`▸ uninstalled (exit ${u.status})`);
    };
  }
  executable = join(dir, "apollo.exe");
  resources = join(dir, "resources");
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
  while (!answered && !exit && Date.now() < deadline) {
    url ??= serverUrlFromLog(readFileSync(logPath, "utf8"));
    answered = url !== null && (await healthy(url));
    if (!answered) await sleep(250);
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
  if (url) {
    // The server must be gone with the app: its port stops answering within a few seconds.
    let still = true;
    for (let i = 0; i < 20 && still; i++) {
      still = await healthy(url);
      if (still) await sleep(250);
    }
    if (still) problems.push(`a server still answers at ${url} after the app exited`);
  }
  if (!existsSync(screenshot) || statSync(screenshot).size === 0) problems.push("no window screenshot: the UI did not load");
  problems.push(...checkMigratedDatabase(dbPath, info.schemaVersion));
  if (problems.length) console.error(`--- app log (seed ${seedVersion}) ---\n${readFileSync(logPath, "utf8").slice(-8000)}\n---`);
  return problems.map((p) => `seed schema ${seedVersion}: ${p}`);
};

const failures: Array<string> = [...stampProblems];
try {
  for (const v of seedVersions) failures.push(...(await runOnce(v)));
} finally {
  uninstall?.();
  if (!process.env.APOLLO_SMOKE_KEEP) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
if (failures.length) {
  console.error(`✗ smoke test failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`✓ smoke test passed (seed schemas ${seedVersions.join(", ")} → ${info.schemaVersion})`);
