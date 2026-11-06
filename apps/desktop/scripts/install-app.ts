/**
 * Builds the desktop app and installs it in /Applications, as a local update.
 *
 *   pnpm --filter @apollo/desktop install:app [--now] [--no-open]
 *
 * Nothing running is disturbed while it builds: the UI is built into build/web (not the
 * apps/web/dist a development run serves) and the app is staged next to the installed
 * one. If Apollo is running (installed, or a development run), the swap waits until no
 * bot is in the middle of a turn, then quits Apollo, moves the new app in and opens it.
 *
 *   --now       don't wait for running turns (they are stopped)
 *   --no-open   don't open Apollo afterwards
 *
 * Signing: the first "Apple Development" identity in the keychain (or APOLLO_SIGN_IDENTITY),
 * so macOS keeps permissions such as the microphone across updates. Without one the app
 * is signed ad hoc, and macOS asks for those permissions again after each update.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("install:app is for macOS. Use `pnpm package` for installers on other systems.");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = "/Applications/Apollo.app";
const staged = "/Applications/.Apollo-update.app";
const previous = "/Applications/.Apollo-previous.app";
const dataDir = process.env.APOLLO_DATA_DIR ?? join(homedir(), ".apollo");
const BUNDLE_ID = "dev.apollo.desktop";

const step = (message: string) => console.log(`\n▸ ${message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (command: string, argv: Array<string>, env: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync(command, argv, { cwd: desktopDir, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`${command} ${argv.join(" ")} failed`);
};

// ---------------------------------------------------------------------------------------
// 1. Build

const signingIdentity = (): string | null => {
  if (process.env.APOLLO_SIGN_IDENTITY) return process.env.APOLLO_SIGN_IDENTITY;
  const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  return /"Apple Development: ([^"]+)"/.exec(out)?.[1] ?? null;
};

step("Building Apollo (the running app is not touched)");
// The pnpm that launched this script (it may not be on PATH).
const execPath = process.env.npm_execpath;
const pnpm = !execPath ? ["pnpm"] : /\.[cm]?js$/.test(execPath) ? [process.execPath, execPath] : [execPath];
run(pnpm[0]!, [...pnpm.slice(1), "build:package"]);
const identity = signingIdentity();
console.log(identity ? `  Signing as Apple Development: ${identity}` : "  No Apple Development identity: signing ad hoc");
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

step(`Staging ${built} → ${staged}`);
rmSync(staged, { recursive: true, force: true });
run("ditto", [built, staged]);

// ---------------------------------------------------------------------------------------
// 2. Wait for running turns, then quit Apollo

/** Main processes of Apollo: the installed app and development runs from this checkout. */
const runningApollo = (): Array<{ pid: number; kind: "installed" | "development" }> => {
  const out = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout;
  const found: Array<{ pid: number; kind: "installed" | "development" }> = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, command] = match as unknown as [string, string, string];
    if (command.startsWith(`${target}/Contents/MacOS/`) && !command.includes("server.mjs")) found.push({ pid: Number(pid), kind: "installed" });
    else if (/Electron\.app\/Contents\/MacOS\/Electron \.$/.test(command) && command.includes(desktopDir.replace(/apps\/desktop$/, ""))) {
      found.push({ pid: Number(pid), kind: "development" });
    }
  }
  return found;
};

/** Sessions mid-turn (or waiting on the user) in Apollo's database. */
const busySessions = (): Array<string> => {
  const path = join(dataDir, "apollo.db");
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("pragma busy_timeout = 3000");
    const rows = db
      .prepare(
        `select s.title, s.status, b.name as bot from sessions s left join bots b on b.id = s.bot_id
         where s.status in ('starting', 'running', 'waiting-approval')`,
      )
      .all() as Array<{ title: string; status: string; bot: string | null }>;
    return rows.map((r) => `${r.bot ?? "?"} / ${r.title} (${r.status})`);
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

/** Apollo servers (installed bundle or development sources), to make sure they stop. */
const serverPids = () =>
  spawnSync("pgrep", ["-f", "(Apollo\\.app/Contents/Resources/server/server\\.mjs|apps/server/src/bin\\.ts)"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number);

const running = runningApollo();
if (running.length > 0) {
  step(`Apollo is running (${running.map((r) => r.kind).join(", ")})`);
  if (!args.has("--now")) {
    let last = "";
    for (;;) {
      const busy = busySessions();
      if (busy.length === 0) break;
      const summary = busy.join("; ");
      if (summary !== last) console.log(`  Waiting for ${busy.length} turn(s) to finish: ${summary}`);
      last = summary;
      await sleep(5000);
    }
    console.log("  No bot is working: updating now.");
  }

  step("Quitting Apollo");
  const servers = serverPids();
  for (const app of running) {
    if (app.kind === "installed") spawnSync("osascript", ["-e", `tell application id "${BUNDLE_ID}" to quit`]);
    else process.kill(app.pid, "SIGTERM");
  }
  // Give the server time to stop its agents and local models cleanly.
  const pids = [...running.map((r) => r.pid), ...servers];
  for (let i = 0; i < 60 && pids.some(isAlive); i++) await sleep(500);
  for (const pid of pids.filter(isAlive)) {
    console.log(`  Process ${pid} did not exit: stopping it`);
    process.kill(pid, "SIGKILL");
  }
}

// ---------------------------------------------------------------------------------------
// 3. Swap and open

step(`Installing ${target}`);
rmSync(previous, { recursive: true, force: true });
if (existsSync(target)) renameSync(target, previous);
renameSync(staged, target);
rmSync(previous, { recursive: true, force: true });

if (!args.has("--no-open")) {
  step("Opening Apollo");
  run("open", [target]);
}
console.log(`\n✓ Apollo updated (${target}).`);
