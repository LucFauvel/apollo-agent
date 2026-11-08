/**
 * install:app's decisions, with fakes for the filesystem, the clock and the app. Nothing
 * here touches /Applications or the running Apollo: the only real runs of the script use
 * --dry-run against a temporary data directory.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  backoff,
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
  restorePrevious,
  swap,
  swapAndVerify,
  waitForIdle,
  writeResult,
  type BundleFs,
  type Bundles,
  type InstallResult,
} from "./install-app-lib.ts";

const B: Bundles = { target: "/A/Apollo.app", staged: "/A/.update.app", previous: "/A/.previous.app", failed: "/A/.failed.app" };

/** A filesystem of bundle paths → contents, recording every operation. */
const fakeFs = (initial: Record<string, string>) => {
  const files = new Map(Object.entries(initial));
  const ops: Array<string> = [];
  const fs: BundleFs = {
    exists: (p) => files.has(p),
    rename: (from, to) => {
      if (!files.has(from)) throw new Error(`ENOENT ${from}`);
      if (files.has(to)) throw new Error(`ENOTEMPTY ${to}`);
      files.set(to, files.get(from)!);
      files.delete(from);
      ops.push(`mv ${from} ${to}`);
    },
    remove: (p) => {
      if (files.delete(p)) ops.push(`rm ${p}`);
    },
  };
  return { fs, files, ops };
};

/** A clock that only moves when the code sleeps; a loop that never ends fails instead of hanging. */
const fakeClock = () => {
  let t = 0;
  let sleeps = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      if (++sleeps > 100_000) throw new Error("runaway loop");
      t += ms;
    },
  };
};

describe("parseArgs", () => {
  it("defaults", () => {
    expect(parseArgs([])).toEqual({ detach: false, now: false, waitTimeoutMs: 120 * 60_000, force: false, dryRun: false, noOpen: false, detachedChild: false });
  });
  it("reads every flag", () => {
    const o = parseArgs(["--detach", "--now", "--force", "--dry-run", "--no-open", "--wait-timeout", "5"]);
    expect(o).toMatchObject({ detach: true, now: true, force: true, dryRun: true, noOpen: true, waitTimeoutMs: 5 * 60_000 });
    expect(parseArgs(["--wait-timeout=0.5"]).waitTimeoutMs).toBe(30_000);
  });
  it("refuses bad values and unknown options", () => {
    for (const bad of [["--wait-timeout"], ["--wait-timeout", "0"], ["--wait-timeout", "-3"], ["--wait-timeout", "soon"], ["--wait-timeout="], ["--detatch"]]) {
      expect(() => parseArgs(bad), bad.join(" ")).toThrow();
    }
  });
  it("the detached child gets the same options without --detach", () => {
    expect(childArgs(["--detach", "--now", "--wait-timeout", "3"])).toEqual(["--now", "--wait-timeout", "3", "--detached-child"]);
    expect(parseArgs(childArgs(["--detach"])).detach).toBe(false);
  });
});

describe("database guard", () => {
  it("allows a missing database, the same schema and an upgrade", () => {
    expect(checkSchema(null, 19, false).ok).toBe(true);
    expect(checkSchema(19, 19, false).ok).toBe(true);
    expect(checkSchema(18, 19, false).ok).toBe(true);
  });
  it("refuses a database newer than the code, unless forced", () => {
    const refused = checkSchema(20, 19, false);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toMatch(/schema version 20.*only knows 19.*--force/s);
    const forced = checkSchema(20, 19, true);
    expect(forced.ok && forced.note).toMatch(/--force/);
  });
  it("reads user_version from a database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-app-db-"));
    const path = join(dir, "apollo.db");
    expect(readDbVersion(path)).toBeNull();
    const db = new DatabaseSync(path);
    db.exec("pragma user_version = 7");
    db.close();
    expect(readDbVersion(path)).toBe(7);
  });
});

describe("waitForIdle", () => {
  it("returns at once when nothing is busy", async () => {
    const clock = fakeClock();
    expect(await waitForIdle({ busy: () => [], ...clock, log: () => {}, timeoutMs: 60_000 })).toEqual({ idle: true });
    expect(clock.now()).toBe(0);
  });
  it("waits for turns to finish", async () => {
    const clock = fakeClock();
    let polls = 0;
    const busy = () => (++polls < 4 ? ["Ceres / work (running)"] : []);
    expect(await waitForIdle({ busy, ...clock, log: () => {}, timeoutMs: 60_000 })).toEqual({ idle: true });
    expect(polls).toBe(4);
  });
  it("gives up after the timeout, naming the busy sessions, and never reports idle while busy", async () => {
    const clock = fakeClock();
    const result = await waitForIdle({ busy: () => ["Ceres / a (running)", "Nebula / b (waiting-approval)"], ...clock, log: () => {}, timeoutMs: 60_000 });
    expect(result).toEqual({ idle: false, busy: ["Ceres / a (running)", "Nebula / b (waiting-approval)"] });
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
    expect(clock.now()).toBeLessThan(70_000);
  });
});

describe("health", () => {
  it("finds APOLLO_PORT in the server's environment", () => {
    const ps = "/Applications/Apollo.app/Contents/MacOS/apollo /Applications/Apollo.app/Contents/Resources/server/server.mjs USER=me APOLLO_PORT=57686 APOLLO_HOST=127.0.0.1";
    expect(portFromPsEnv(ps)).toBe(57686);
    expect(portFromPsEnv("x XAPOLLO_PORT=1 APOLLO_PORTS=2")).toBeNull();
    expect(portFromPsEnv("x APOLLO_PORT=99999")).toBeNull();
    expect(portFromPsEnv("")).toBeNull();
  });
  it("lists only loopback listening ports from lsof", () => {
    const lsof = [
      "COMMAND   PID    USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME",
      "apollo  86317 me   19u  IPv4 0x1      0t0  TCP 127.0.0.1:57686 (LISTEN)",
      "apollo  86317 me   23u  IPv4 0x2      0t0  TCP 127.0.0.1:57896 (LISTEN)",
      "apollo  86317 me   37u  IPv4 0x3      0t0  TCP *:47468 (LISTEN)",
    ].join("\n");
    expect(portsFromLsof(lsof)).toEqual([57686, 57896]);
  });
  it("only a 200 {ok:true} is healthy", () => {
    expect(isHealthyResponse(200, '{"ok":true}')).toBe(true);
    expect(isHealthyResponse(200, '{"ok":false}')).toBe(false);
    expect(isHealthyResponse(200, '{"ok":"true"}')).toBe(false);
    expect(isHealthyResponse(401, '{"ok":true}')).toBe(false);
    expect(isHealthyResponse(200, "<html>")).toBe(false);
  });
});

describe("relaunchUntilHealthy", () => {
  it("opens again until the app answers (an `open` right after a force-quit can do nothing)", async () => {
    const clock = fakeClock();
    let opens = 0;
    // The first open is swallowed; the app comes up a few seconds after the second.
    let upAt = Infinity;
    const ok = await relaunchUntilHealthy({
      open: () => void (++opens === 2 && (upAt = clock.now() + 3000)),
      healthy: async () => clock.now() >= upAt,
      ...clock,
      log: () => {},
      timeoutMs: 120_000,
    });
    expect(ok).toBe(true);
    expect(opens).toBe(2);
  });
  it("gives up after the timeout", async () => {
    const clock = fakeClock();
    let opens = 0;
    const ok = await relaunchUntilHealthy({ open: () => void opens++, healthy: async () => false, ...clock, log: () => {}, timeoutMs: 120_000 });
    expect(ok).toBe(false);
    expect(opens).toBeGreaterThan(5);
    expect(clock.now()).toBeGreaterThanOrEqual(120_000);
    expect(clock.now()).toBeLessThan(125_000);
  });
  it("backs off, up to a few seconds", () => {
    expect([0, 1, 2, 3, 4, 10].map(backoff)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });
});

describe("bundles", () => {
  it("swap keeps the old app as previous and moves the staged one in", () => {
    const { fs, files, ops } = fakeFs({ [B.target]: "old", [B.staged]: "new", [B.previous]: "stale" });
    swap(fs, B);
    expect(Object.fromEntries(files)).toEqual({ [B.target]: "new", [B.previous]: "old" });
    expect(ops).toEqual([`rm ${B.previous}`, `mv ${B.target} ${B.previous}`, `mv ${B.staged} ${B.target}`]);
  });
  it("swap refuses without a staged build, touching nothing", () => {
    const { fs, files } = fakeFs({ [B.target]: "old" });
    expect(() => swap(fs, B)).toThrow(/Nothing staged/);
    expect(Object.fromEntries(files)).toEqual({ [B.target]: "old" });
  });
  it("restorePrevious puts the old app back and keeps the bad one aside", () => {
    const { fs, files } = fakeFs({ [B.target]: "new", [B.previous]: "old", [B.failed]: "older-failure" });
    expect(restorePrevious(fs, B)).toBe(true);
    expect(Object.fromEntries(files)).toEqual({ [B.target]: "old", [B.failed]: "new" });
    expect(restorePrevious(fakeFs({ [B.target]: "new" }).fs, B)).toBe(false);
  });
  it("recovery restores previous only when the app is missing", () => {
    const missing = fakeFs({ [B.previous]: "old" });
    expect(recoverIfNeeded(missing.fs, B)).toBe(true);
    expect(Object.fromEntries(missing.files)).toEqual({ [B.target]: "old" });
    const present = fakeFs({ [B.target]: "new", [B.previous]: "old" });
    expect(recoverIfNeeded(present.fs, B)).toBe(false);
    expect(present.ops).toEqual([]);
    expect(recoverIfNeeded(fakeFs({}).fs, B)).toBe(false);
  });
});

describe("swapAndVerify", () => {
  const run = async (initial: Record<string, string>, health: Array<boolean>, open = true) => {
    const { fs, files, ops } = fakeFs(initial);
    const events: Array<string> = [];
    const outcome = await swapAndVerify({
      fs,
      bundles: B,
      relaunch: async () => {
        events.push(`relaunch ${files.get(B.target)}`);
        return health.shift() ?? false;
      },
      stopApp: async () => void events.push(`stop ${files.get(B.target)}`),
      log: () => {},
      open,
    });
    return { outcome, files: Object.fromEntries(files), ops, events };
  };

  it("healthy: the previous app is deleted only after /health passed", async () => {
    const r = await run({ [B.target]: "old", [B.staged]: "new" }, [true]);
    expect(r.outcome).toEqual({ status: "ok", stage: "healthy" });
    expect(r.files).toEqual({ [B.target]: "new" });
    expect(r.events).toEqual(["relaunch new"]);
    expect(r.ops.at(-1)).toBe(`rm ${B.previous}`);
  });
  it("unhealthy: stops the new app, restores the previous one and relaunches it", async () => {
    const r = await run({ [B.target]: "old", [B.staged]: "new" }, [false, true]);
    expect(r.outcome.status).toBe("rolled-back");
    expect(r.files).toEqual({ [B.target]: "old", [B.failed]: "new" });
    expect(r.events).toEqual(["relaunch new", "stop new", "relaunch old"]);
  });
  it("rollback that is not healthy either is a failure, with the old app still in place", async () => {
    const r = await run({ [B.target]: "old", [B.staged]: "new" }, [false, false]);
    expect(r.outcome).toMatchObject({ status: "failed", stage: "rollback-unhealthy" });
    expect(r.files[B.target]).toBe("old");
  });
  it("first install (no previous app) that is unhealthy fails without removing it", async () => {
    const r = await run({ [B.staged]: "new" }, [false]);
    expect(r.outcome).toMatchObject({ status: "failed", stage: "no-previous" });
    expect(r.files).toEqual({ [B.target]: "new" });
  });
  it("--no-open keeps the previous app (its health is unknown)", async () => {
    const r = await run({ [B.target]: "old", [B.staged]: "new" }, [], false);
    expect(r.outcome).toEqual({ status: "ok", stage: "installed-not-opened" });
    expect(r.files).toEqual({ [B.target]: "new", [B.previous]: "old" });
    expect(r.events).toEqual([]);
  });
});

describe("writeResult", () => {
  it("writes the whole JSON file in place, replacing the last one", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-app-result-"));
    const path = join(dir, "logs", "install-app-last.result");
    const result: InstallResult = {
      status: "running",
      stage: "build",
      build: null,
      startedAt: "2026-11-08T00:00:00.000Z",
      finishedAt: null,
      error: null,
      log: null,
      pid: 1,
    };
    writeResult(path, result);
    writeResult(path, { ...result, status: "rolled-back", stage: "rollback-healthy", error: "boom", finishedAt: "2026-11-08T00:01:00.000Z" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ status: "rolled-back", stage: "rollback-healthy", error: "boom" });
    expect(readdirSync(join(dir, "logs"))).toEqual(["install-app-last.result"]);
  });
});

describe("plan", () => {
  const base = {
    options: parseArgs([]),
    targetExists: true,
    previousExists: false,
    running: ["installed pid 1"],
    busy: [],
    schema: checkSchema(19, 19, false),
    bundles: B,
  };
  it("recovery comes first, and is all that happens", () => {
    expect(plan({ ...base, targetExists: false, previousExists: true })).toEqual([expect.stringMatching(/^Recovery/)]);
  });
  it("a newer database stops everything", () => {
    expect(plan({ ...base, schema: checkSchema(20, 19, false) })).toEqual([expect.stringMatching(/^Refuse/)]);
  });
  it("waits for busy bots, with the timeout", () => {
    const steps = plan({ ...base, busy: ["Ceres / x (running)"], options: parseArgs(["--wait-timeout", "15"]) }).join("\n");
    expect(steps).toMatch(/Wait up to 15 min for: Ceres \/ x.*abort/);
    expect(steps).toMatch(/Not healthy: stop it/);
  });
  it("--now and --no-open", () => {
    const steps = plan({ ...base, busy: ["Ceres / x (running)"], options: parseArgs(["--now", "--no-open"]) }).join("\n");
    expect(steps).toMatch(/--now: don't wait/);
    expect(steps).toMatch(/--no-open: don't open; keep/);
    expect(steps).not.toMatch(/Open until/);
  });
});

describe("install-app.ts --dry-run (real script, temporary data directory)", () => {
  const script = join(import.meta.dirname, "install-app.ts");
  const dryRun = (dataDir: string, ...args: Array<string>) =>
    spawnSync(process.execPath, [script, "--dry-run", ...args], { encoding: "utf8", env: { ...process.env, APOLLO_DATA_DIR: dataDir }, timeout: 30_000 });

  it("prints a plan, writes no result file", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-app-dry-"));
    const r = dryRun(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Dry run: nothing is built, quit or moved/);
    expect(r.stdout).toMatch(/Database: no database yet/);
    expect(existsSync(join(dir, "logs", "install-app-last.result"))).toBe(false);
  });
  it("refuses a newer database, unless --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-app-dry-"));
    const db = new DatabaseSync(join(dir, "apollo.db"));
    db.exec("pragma user_version = 100000");
    db.close();
    expect(dryRun(dir).stdout).toMatch(/Refuse: The database is at schema version 100000/);
    expect(dryRun(dir, "--force").stdout).toMatch(/Installing anyway \(--force\)/);
  });
  it("--detach returns at once and the child logs to a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "install-app-dry-"));
    const r = dryRun(dir, "--detach");
    expect(r.status).toBe(0);
    const logPath = /log:\s+(\S+)/.exec(r.stdout)?.[1];
    expect(logPath).toMatch(new RegExp(`^${dir}/logs/install-app-\\d+\\.log$`));
    for (let i = 0; i < 100 && !readFileSync(logPath!, "utf8").includes("Dry run"); i++) await new Promise((res) => setTimeout(res, 100));
    expect(readFileSync(logPath!, "utf8")).toMatch(/Dry run: nothing is built/);
  });
  it("rejects unknown options before doing anything", () => {
    const r = dryRun(mkdtempSync(join(tmpdir(), "install-app-dry-")), "--bogus");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown option --bogus/);
  });
});
