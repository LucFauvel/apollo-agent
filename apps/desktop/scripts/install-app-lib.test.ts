/**
 * install:app's building blocks, with fakes for the clock and temporary directories for
 * files and databases. Nothing here touches /Applications, ~/.apollo or the running Apollo:
 * the only real runs of the script use --dry-run against a temporary data directory.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  acquireLock,
  backoff,
  checkSchema,
  childArgs,
  healthUrls,
  isHealthyResponse,
  listenersFromLsof,
  listSnapshots,
  lockHolder,
  parseArgs,
  plan,
  portsFromPsEnv,
  pruneSnapshots,
  readMarker,
  realFileOps,
  realSqliteOps,
  relaunchUntilHealthy,
  releaseLock,
  restorePrevious,
  restoreSnapshot,
  staysHealthy,
  swap,
  takeSnapshot,
  validateSnapshot,
  waitForIdle,
  writeResult,
  type BundleFs,
  type Bundles,
  type FileOps,
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

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `install-app-${name}-`));
const makeDb = (path: string, version: number) => {
  const db = new DatabaseSync(path);
  db.exec(`create table if not exists t (v integer); insert into t values (${version}); pragma user_version = ${version}`);
  db.close();
};
/** Real file operations, failing where `fail` says. */
const failing = (fail: (op: keyof FileOps, args: ReadonlyArray<string>) => boolean): FileOps =>
  Object.fromEntries(
    Object.entries(realFileOps).map(([op, fn]) => [
      op,
      (...args: Array<string>) => {
        if (fail(op as keyof FileOps, args)) throw new Error(`${op}: injected failure`);
        return (fn as (...a: Array<string>) => unknown)(...args);
      },
    ]),
  ) as unknown as FileOps;

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
  it("inspects a database file: version and soundness", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-app-db-"));
    const path = join(dir, "apollo.db");
    expect(realSqliteOps.inspect(path)).toBeNull();
    const db = new DatabaseSync(path);
    db.exec("pragma user_version = 7");
    db.close();
    expect(realSqliteOps.inspect(path)).toEqual({ version: 7, ok: true });
    writeFileSync(path, "not a database at all, padded ".repeat(200));
    expect(realSqliteOps.inspect(path)?.ok).toBe(false);
    // Opens, reads its version, but fails quick_check: two cell pointers to one cell.
    const torn = join(mkdtempSync(join(tmpdir(), "install-app-db-")), "torn.db");
    const db2 = new DatabaseSync(torn);
    db2.exec("pragma page_size = 4096; create table t (v text); pragma user_version = 3;");
    const insert = db2.prepare("insert into t values (?)");
    for (let i = 0; i < 500; i++) insert.run(`${"x".repeat(100)}${i}`);
    db2.close();
    const fd = openSync(torn, "r+");
    const header = Buffer.alloc(10);
    readSync(fd, header, 0, 10, 2 * 4096);
    writeSync(fd, header.subarray(8, 10), 0, 2, 2 * 4096 + 10);
    closeSync(fd);
    expect(realSqliteOps.inspect(torn)).toEqual({ version: 3, ok: false });
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
  it("finds APOLLO_PORT tokens, exact name only", () => {
    expect(portsFromPsEnv("/x/apollo /x/server.mjs USER=me APOLLO_PORT=57686 APOLLO_HOST=127.0.0.1")).toEqual([57686]);
    expect(portsFromPsEnv("x XAPOLLO_PORT=1 APOLLO_PORTS=2 APOLLO_NODE_PORT=3 APOLLO_PORT=4x")).toEqual([]);
    expect(portsFromPsEnv("x APOLLO_PORT=99999")).toEqual([]);
    expect(portsFromPsEnv("x --note APOLLO_PORT=5733 USER=me APOLLO_PORT=64000")).toEqual([5733, 64000]);
  });
  it("lists loopback listeners from lsof, IPv6 included, wildcard excluded", () => {
    const lsof = [
      "COMMAND   PID    USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME",
      "apollo  86317 me   19u  IPv4 0x1      0t0  TCP 127.0.0.1:57686 (LISTEN)",
      "apollo  86317 me   23u  IPv6 0x2      0t0  TCP [::1]:57896 (LISTEN)",
      "apollo  86317 me   37u  IPv4 0x3      0t0  TCP *:47468 (LISTEN)",
    ].join("\n");
    expect(listenersFromLsof(lsof)).toEqual([
      { host: "127.0.0.1", port: 57686 },
      { host: "[::1]", port: 57896 },
    ]);
  });
  it("asks only ports the server really listens on: a forged APOLLO_PORT is ignored", () => {
    const lsof = "apollo 1 me 19u IPv4 0x1 0t0 TCP 127.0.0.1:64000 (LISTEN)\napollo 1 me 20u IPv4 0x1 0t0 TCP 127.0.0.1:64001 (LISTEN)";
    expect(healthUrls("x --note APOLLO_PORT=5733 USER=me APOLLO_PORT=64000", lsof)).toEqual(["http://127.0.0.1:64000/health"]);
    // No APOLLO_PORT: every loopback port of that process.
    expect(healthUrls("x", lsof)).toEqual(["http://127.0.0.1:64000/health", "http://127.0.0.1:64001/health"]);
    expect(healthUrls("x APOLLO_PORT=5733", lsof)).toEqual([]);
    expect(healthUrls("x APOLLO_PORT=1", "a 1 me 1u IPv6 0 0t0 TCP [::1]:1 (LISTEN)")).toEqual(["http://[::1]:1/health"]);
  });
  it("only a 200 {ok:true} is healthy", () => {
    expect(isHealthyResponse(200, '{"ok":true}')).toBe(true);
    expect(isHealthyResponse(200, '{"ok":false}')).toBe(false);
    expect(isHealthyResponse(200, '{"ok":"true"}')).toBe(false);
    expect(isHealthyResponse(401, '{"ok":true}')).toBe(false);
    expect(isHealthyResponse(200, "<html>")).toBe(false);
  });
  it("staysHealthy needs every sample", async () => {
    const clock = fakeClock();
    let calls = 0;
    expect(await staysHealthy({ healthy: async () => ++calls !== 3, sleep: clock.sleep, samples: 3, intervalMs: 5000 })).toBe(false);
    expect(await staysHealthy({ healthy: async () => true, sleep: clock.sleep, samples: 3, intervalMs: 5000 })).toBe(true);
    expect(clock.now()).toBe(30_000);
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
});

describe("database snapshots", () => {
  it("one self-contained file (the -wal folded in), with its version and SHA-256", () => {
    const data = tmp("snap");
    const dbPath = join(data, "apollo.db");
    makeDb(dbPath, 5);
    // A database left in WAL mode with committed data still in the -wal.
    const live = new DatabaseSync(dbPath);
    live.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0; insert into t values (42)");
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    const snap = takeSnapshot({ dbPath, backupsDir: join(data, "backups"), label: "abc123/dirty", now: 1000 })!;
    live.close();
    expect(snap).toEqual({ dir: join(data, "backups", "pre-update-1000-abc123_dirty"), createdAt: 1000, dbVersion: 5 });
    expect(readdirSync(snap.dir).sort()).toEqual(["apollo.db", "snapshot.json"]);
    const copy = new DatabaseSync(join(snap.dir, "apollo.db"), { readOnly: true });
    expect(copy.prepare("select count(*) as n from t where v = 42").get()).toEqual({ n: 1 });
    copy.close();
    expect(validateSnapshot(snap.dir)).toEqual({ ok: true, version: 5, file: join(snap.dir, "apollo.db") });
    expect(takeSnapshot({ dbPath: join(data, "none.db"), backupsDir: join(data, "backups"), label: "x", now: 2 })).toBeNull();
  });

  it("validation refuses a changed file, a wrong recorded version, a missing manifest", () => {
    const data = tmp("validate");
    const dbPath = join(data, "apollo.db");
    makeDb(dbPath, 5);
    const a = takeSnapshot({ dbPath, backupsDir: join(data, "b"), label: "a", now: 1 })!;
    writeFileSync(join(a.dir, "apollo.db"), "not a SQLite database");
    expect(validateSnapshot(a.dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/SHA-256/) });
    const b = takeSnapshot({ dbPath, backupsDir: join(data, "b"), label: "b", now: 2 })!;
    const manifest = JSON.parse(readFileSync(join(b.dir, "snapshot.json"), "utf8"));
    writeFileSync(join(b.dir, "snapshot.json"), JSON.stringify({ ...manifest, dbVersion: 4 }));
    expect(validateSnapshot(b.dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/recorded as 4/) });
    const c = join(data, "b", "pre-update-3-c");
    mkdirSync(c);
    expect(validateSnapshot(c)).toMatchObject({ ok: false });
    // A file whose hash matches but SQLite cannot read (hash recorded over garbage).
    const d = takeSnapshot({ dbPath, backupsDir: join(data, "b"), label: "d", now: 4 })!;
    writeFileSync(join(d.dir, "apollo.db"), "garbage ".repeat(100));
    const md = JSON.parse(readFileSync(join(d.dir, "snapshot.json"), "utf8"));
    writeFileSync(join(d.dir, "snapshot.json"), JSON.stringify({ ...md, sha256: { "apollo.db": realFileOps.sha256(join(d.dir, "apollo.db")) } }));
    expect(validateSnapshot(d.dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a sound SQLite/) });
  });

  it("malformed or unreadable metadata is an unusable snapshot, never an exception", () => {
    const data = tmp("malformed");
    const dbPath = join(data, "apollo.db");
    makeDb(dbPath, 5);
    const snap = takeSnapshot({ dbPath, backupsDir: join(data, "b"), label: "a", now: 1 })!;
    const good = readFileSync(join(snap.dir, "snapshot.json"), "utf8");
    // Pointing outside the snapshot, at the live database itself, with its real hash.
    const escape = JSON.stringify({ ...JSON.parse(good), file: "../../apollo.db", sha256: { "../../apollo.db": realFileOps.sha256(dbPath) } });
    for (const manifest of ["{}", "null", "[]", escape, JSON.stringify({ ...JSON.parse(good), file: undefined })]) {
      writeFileSync(join(snap.dir, "snapshot.json"), manifest);
      expect(validateSnapshot(snap.dir), manifest).toMatchObject({ ok: false });
    }
    writeFileSync(join(snap.dir, "snapshot.json"), good);
    const hashFails: FileOps = { ...realFileOps, sha256: () => { throw new Error("EIO"); } };
    expect(validateSnapshot(snap.dir, hashFails)).toMatchObject({ ok: false, reason: expect.stringMatching(/EIO/) });
    expect(validateSnapshot(snap.dir).ok).toBe(true);
  });

  it("restore: the snapshot in place, the replaced database and its stale -wal/-shm kept aside", () => {
    const data = tmp("restore");
    const dbPath = join(data, "apollo.db");
    makeDb(dbPath, 5);
    const snap = takeSnapshot({ dbPath, backupsDir: join(data, "backups"), label: "c", now: 1 })!;
    makeDb(dbPath, 7);
    writeFileSync(`${dbPath}-wal`, "new build's wal");
    writeFileSync(`${dbPath}-shm`, "new build's shm");
    let committed = 0;
    const { aside, version } = restoreSnapshot({ snapshotDir: snap.dir, dbPath, now: 2, beforeCommit: () => void committed++ });
    expect(committed).toBe(1);
    expect(version).toBe(5);
    expect(realSqliteOps.inspect(dbPath)).toEqual({ version: 5, ok: true });
    expect(readdirSync(data).sort()).toEqual(["apollo.db", "backups"]);
    expect(readdirSync(aside).sort()).toEqual(["apollo.db", "apollo.db-shm", "apollo.db-wal"]);
    expect(realSqliteOps.inspect(join(aside, "apollo.db"))?.version).toBe(7);
    expect(validateSnapshot(snap.dir).ok).toBe(true);
  });

  it("restore refuses an invalid snapshot and leaves the database alone", () => {
    const data = tmp("restore-bad");
    const dbPath = join(data, "apollo.db");
    makeDb(dbPath, 5);
    const snap = takeSnapshot({ dbPath, backupsDir: join(data, "backups"), label: "c", now: 1 })!;
    writeFileSync(join(snap.dir, "apollo.db"), "not a SQLite database");
    makeDb(dbPath, 7);
    expect(() => restoreSnapshot({ snapshotDir: snap.dir, dbPath, now: 2, beforeCommit: () => {} })).toThrow(/not usable/);
    expect(realSqliteOps.inspect(dbPath)?.version).toBe(7);
  });

  it("a failure before the commit changes nothing; beforeCommit failing stops it too", () => {
    const data = tmp("restore-early");
    const dbPath = join(data, "apollo.db");
    makeDb(dbPath, 5);
    const snap = takeSnapshot({ dbPath, backupsDir: join(data, "backups"), label: "c", now: 1 })!;
    makeDb(dbPath, 7);
    writeFileSync(`${dbPath}-wal`, "");
    let committed = 0;
    const copyFails = failing((op, [, to]) => op === "copy" && to!.includes(".restore-"));
    expect(() => restoreSnapshot({ snapshotDir: snap.dir, dbPath, now: 2, beforeCommit: () => void committed++ }, copyFails)).toThrow();
    expect(committed).toBe(0);
    expect(realSqliteOps.inspect(dbPath)?.version).toBe(7);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(() =>
      restoreSnapshot({ snapshotDir: snap.dir, dbPath, now: 3, beforeCommit: () => { throw new Error("marker: ENOSPC"); } }),
    ).toThrow(/ENOSPC/);
    expect(realSqliteOps.inspect(dbPath)?.version).toBe(7);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
  });

  it("a copy that does not match the snapshot is caught before anything changes", () => {
    const data = tmp("restore-copy");
    const dbPath = join(data, "apollo.db");
    makeDb(dbPath, 5);
    const snap = takeSnapshot({ dbPath, backupsDir: join(data, "backups"), label: "c", now: 1 })!;
    makeDb(dbPath, 7);
    let committed = 0;
    const corrupting: FileOps = {
      ...realFileOps,
      copy: (from, to) => (to.includes(".restore-") ? writeFileSync(to, "torn copy") : realFileOps.copy(from, to)),
    };
    expect(() => restoreSnapshot({ snapshotDir: snap.dir, dbPath, now: 2, beforeCommit: () => void committed++ }, corrupting)).toThrow(/does not match/);
    // Same hash, but not readable at the right version (a lying SQLite read of the copy).
    const badCopy = { ...realSqliteOps, inspect: (p: string) => (p.includes(".restore-") ? { version: 5, ok: false } : realSqliteOps.inspect(p)) };
    expect(() => restoreSnapshot({ snapshotDir: snap.dir, dbPath, now: 3, beforeCommit: () => void committed++ }, realFileOps, badCopy)).toThrow(/not readable/);
    expect(committed).toBe(0);
    expect(realSqliteOps.inspect(dbPath)?.version).toBe(7);
  });

  it("an interrupted commit never leaves no database: the replaced one stays until the copy is renamed in", () => {
    const data = tmp("restore-commit");
    const dbPath = join(data, "apollo.db");
    makeDb(dbPath, 5);
    const snap = takeSnapshot({ dbPath, backupsDir: join(data, "backups"), label: "c", now: 1 })!;
    makeDb(dbPath, 7);
    const renameFails = failing((op, [from]) => op === "rename" && from!.includes(".restore-"));
    expect(() => restoreSnapshot({ snapshotDir: snap.dir, dbPath, now: 2, beforeCommit: () => {} }, renameFails)).toThrow();
    expect(realSqliteOps.inspect(dbPath)?.version).toBe(7);
    // And a copy that does not read back after the rename is reported.
    const badRead = { ...realSqliteOps, inspect: (p: string) => (p === dbPath ? { version: 5, ok: false } : realSqliteOps.inspect(p)) };
    expect(() => restoreSnapshot({ snapshotDir: snap.dir, dbPath, now: 3, beforeCommit: () => {} }, realFileOps, badRead)).toThrow(/does not read back/);
  });

  it("prune keeps the newest, and always the protected ones", () => {
    const data = tmp("prune");
    const dbPath = join(data, "apollo.db");
    makeDb(dbPath, 1);
    const backups = join(data, "backups");
    const snaps = [10, 40, 20, 30].map((now) => takeSnapshot({ dbPath, backupsDir: backups, label: "c", now })!);
    mkdirSync(join(backups, "pre-update-5-incomplete"));
    mkdirSync(join(backups, "unrelated"));
    expect(listSnapshots(backups).map((s) => s.createdAt)).toEqual([40, 30, 20, 10, 5]);
    const removed = pruneSnapshots(backups, 2, [snaps[2]!.dir]);
    expect(removed.sort()).toEqual([snaps[0]!.dir, join(backups, "pre-update-5-incomplete")].sort());
    expect(listSnapshots(backups).map((s) => s.createdAt)).toEqual([40, 30, 20]);
    expect(existsSync(join(backups, "unrelated"))).toBe(true);
    pruneSnapshots(backups, 2, []);
    expect(listSnapshots(backups).map((s) => s.createdAt)).toEqual([40, 30]);
  });
});

describe("lock", () => {
  const gen = (dir: string, n: number) => join(dir, `${String(n).padStart(12, "0")}.json`);
  const owners = (dir: string) => readdirSync(dir).filter((e) => e.endsWith(".json")).sort();

  it("one holder at a time; a dead or reused pid is stale; release frees it", () => {
    const dir = join(tmp("lock"), "install-app.lock");
    const alive = new Set([1, 2]);
    const isInstaller = (pid: number) => alive.has(pid);
    expect(acquireLock(dir, { pid: 1, startedAt: "a" }, isInstaller)).toEqual({ ok: true, generation: 1, tookOver: null });
    expect(acquireLock(dir, { pid: 2, startedAt: "b" }, isInstaller)).toEqual({ ok: false, holder: { pid: 1, startedAt: "a" }, state: "alive" });
    expect(lockHolder(dir, isInstaller)).toEqual({ holder: { pid: 1, startedAt: "a" }, state: "alive" });
    releaseLock(dir, 1, { pid: 2, startedAt: "b" });
    expect(owners(dir)).toHaveLength(1);
    alive.delete(1);
    expect(lockHolder(dir, isInstaller)).toBeNull();
    expect(acquireLock(dir, { pid: 2, startedAt: "b" }, isInstaller)).toEqual({ ok: true, generation: 2, tookOver: { pid: 1, startedAt: "a" } });
    // The stale generation is tidied away.
    expect(owners(dir)).toEqual(["000000000002.json"]);
    releaseLock(dir, 2, { pid: 2, startedAt: "b" });
    expect(owners(dir)).toEqual([]);
    expect(acquireLock(dir, { pid: 1, startedAt: "c" }, () => true)).toMatchObject({ ok: true });
  });

  it("stale takeover race: two contenders that both see the dead owner cannot both win", () => {
    const dir = join(tmp("lock"), "install-app.lock");
    mkdirSync(dir);
    writeFileSync(gen(dir, 1), JSON.stringify({ pid: 9, startedAt: "dead" }));
    const isInstaller = (pid: number) => pid === 1 || pid === 2;
    let b: ReturnType<typeof acquireLock> | null = null;
    // A has decided the owner is stale; right before A publishes, B runs its whole acquire.
    const hooked: FileOps = {
      ...realFileOps,
      publishExclusive: (path, text) => {
        b ??= acquireLock(dir, { pid: 2, startedAt: "b" }, isInstaller);
        return realFileOps.publishExclusive(path, text);
      },
    };
    const a = acquireLock(dir, { pid: 1, startedAt: "a" }, isInstaller, hooked);
    expect(b).toMatchObject({ ok: true });
    expect(a).toEqual({ ok: false, holder: { pid: 2, startedAt: "b" }, state: "alive" });
    expect(owners(dir)).toEqual(["000000000002.json"]);
  });

  it("a slow contender with an old view publishes below the owner, sees it, and withdraws", () => {
    const dir = join(tmp("lock"), "install-app.lock");
    mkdirSync(dir);
    writeFileSync(gen(dir, 3), JSON.stringify({ pid: 9, startedAt: "dead" }));
    writeFileSync(gen(dir, 5), JSON.stringify({ pid: 5, startedAt: "owner" }));
    let calls = 0;
    // Its first look predates the owner's generation 5 (and generation 4 was tidied away).
    const stale: FileOps = { ...realFileOps, list: (d) => (calls++ === 0 ? ["000000000003.json"] : realFileOps.list(d)) };
    const r = acquireLock(dir, { pid: 2, startedAt: "slow" }, (pid) => pid === 5 || pid === 2, stale);
    expect(r).toEqual({ ok: false, holder: { pid: 5, startedAt: "owner" }, state: "alive" });
    expect(existsSync(gen(dir, 4))).toBe(false);
  });

  it("an owner that cannot be checked, or a lock file that cannot be read, counts as held", () => {
    const dir = join(tmp("lock"), "install-app.lock");
    mkdirSync(dir);
    writeFileSync(gen(dir, 1), JSON.stringify({ pid: 7, startedAt: "x" }));
    const cannotTell = () => {
      throw new Error("ps: EPERM");
    };
    expect(acquireLock(dir, { pid: 1, startedAt: "a" }, cannotTell)).toEqual({ ok: false, holder: { pid: 7, startedAt: "x" }, state: "unknown" });
    expect(lockHolder(dir, cannotTell)).toEqual({ holder: { pid: 7, startedAt: "x" }, state: "unknown" });
    writeFileSync(gen(dir, 2), "");
    expect(acquireLock(dir, { pid: 1, startedAt: "a" }, () => false)).toEqual({ ok: false, holder: null, state: "unknown" });
    expect(owners(dir)).toEqual(["000000000001.json", "000000000002.json"]);
  });

  it("publishing is atomic and exclusive, and leaves no temporary files", () => {
    const dir = tmp("publish");
    const path = join(dir, "x.json");
    expect(realFileOps.publishExclusive(path, "one")).toBe(true);
    expect(realFileOps.publishExclusive(path, "two")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("one");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("an unreadable marker still counts as an unfinished install", () => {
    const dir = tmp("marker");
    expect(readMarker(join(dir, "none.json"))).toBeNull();
    writeFileSync(join(dir, "m.json"), "{");
    expect(readMarker(join(dir, "m.json"))).toMatchObject({ phase: "rolling-back" });
  });
});

describe("writeResult", () => {
  it("writes the whole JSON file in place, replacing the last one", () => {
    const dir = tmp("result");
    const path = join(dir, "logs", "install-app-last.result");
    const result: InstallResult = { status: "running", stage: "build", build: null, startedAt: "s", finishedAt: null, error: null, manual: null, log: null, pid: 1, snapshot: null };
    writeResult(path, result);
    writeResult(path, { ...result, status: "rolled-back", stage: "rollback", error: "boom", finishedAt: "f" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ status: "rolled-back", stage: "rollback", error: "boom" });
    expect(readdirSync(join(dir, "logs"))).toEqual(["install-app-last.result"]);
  });
});

describe("plan", () => {
  const base = {
    options: parseArgs([]),
    targetExists: true,
    previousExists: false,
    marker: null,
    lock: null,
    running: ["installed 1"],
    busy: [],
    schema: checkSchema(19, 19, false),
    bundles: B,
    hasDb: true,
    backupsDir: "/data/backups",
  };
  it("a held lock, then recovery, come first", () => {
    expect(plan({ ...base, lock: { holder: { pid: 9, startedAt: "x" }, state: "alive" } })).toEqual([expect.stringMatching(/^Refuse: another install:app \(pid 9/)]);
    expect(plan({ ...base, lock: { holder: { pid: 9, startedAt: "x" }, state: "unknown" } })).toEqual([expect.stringMatching(/^Refuse: the install lock is held by pid 9/)]);
    expect(plan({ ...base, running: null })).toEqual([expect.stringMatching(/^Refuse: the process list cannot be read/)]);
    expect(plan({ ...base, targetExists: false, previousExists: true })).toEqual([expect.stringMatching(/^Recovery/)]);
    expect(plan({ ...base, marker: { phase: "restoring-db", startedAt: "x", pid: 1, snapshot: null, previousSchema: 18 } })).toEqual([expect.stringMatching(/^Recovery.*phase restoring-db/)]);
  });
  it("a newer database stops everything", () => {
    expect(plan({ ...base, schema: checkSchema(20, 19, false) })).toEqual([expect.stringMatching(/^Refuse/)]);
  });
  it("waits, stops, snapshots, swaps, verifies, rolls back", () => {
    const steps = plan({ ...base, busy: ["Ceres / x (running)"], options: parseArgs(["--wait-timeout", "15"]) }).join("\n");
    expect(steps).toMatch(/Wait up to 15 min for: Ceres \/ x.*abort/);
    expect(steps).toMatch(/Snapshot the database to \/data\/backups\/pre-update-….*keeping the last 2\nSwap:/);
    expect(steps).toMatch(/stay healthy for 15 s/);
    expect(steps).toMatch(/Not healthy .*restore the database snapshot .*nothing is opened/);
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
  /** Every file under a directory, with size and modification time. */
  const snapshotTree = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const s = statSync(p);
          out[p] = `${s.size}:${s.mtimeMs}`;
        }
      }
    };
    walk(dir);
    return out;
  };

  it("writes nothing at all, even with a WAL database without -shm and --detach", () => {
    const dir = tmp("dry");
    const dbPath = join(dir, "apollo.db");
    makeDb(dbPath, 19);
    const live = new DatabaseSync(dbPath);
    live.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0; insert into t values (1)");
    // Keep the -wal, lose the -shm, as after a crash.
    const wal = readFileSync(`${dbPath}-wal`);
    live.close();
    writeFileSync(`${dbPath}-wal`, wal);
    realFileOps.remove(`${dbPath}-shm`);
    const before = snapshotTree(dir);
    for (const args of [[], ["--detach"]]) {
      const r = dryRun(dir, ...args);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/Dry run: nothing is built, stopped, moved or written/);
      expect(r.stdout).toMatch(/Database: schema 19/);
    }
    expect(snapshotTree(dir)).toEqual(before);
  });
  it("refuses a newer database, unless --force", () => {
    const dir = tmp("dry");
    makeDb(join(dir, "apollo.db"), 100000);
    expect(dryRun(dir).stdout).toMatch(/Refuse: The database is at schema version 100000/);
    expect(dryRun(dir, "--force").stdout).toMatch(/Installing anyway \(--force\)/);
  });
  it("shows a pending install as recovery", () => {
    const dir = tmp("dry");
    writeFileSync(join(dir, "install-app.pending.json"), JSON.stringify({ phase: "verifying", startedAt: "x", pid: 1, snapshot: null, previousSchema: 18 }));
    expect(dryRun(dir).stdout).toMatch(/Recovery: an install did not finish \(phase verifying\)/);
  });
  /** --dry-run with a fake `ps` first on PATH. */
  const withPs = (psScript: string, dataDir = tmp("dry")) => {
    const bin = tmp("bin");
    writeFileSync(join(bin, "ps"), `#!/bin/sh\n${psScript}\n`, { mode: 0o755 });
    return spawnSync(process.execPath, [script, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, APOLLO_DATA_DIR: dataDir, PATH: `${bin}:${process.env.PATH}` },
      timeout: 30_000,
    });
  };
  it("a failing ps is reported as 'cannot tell', not as 'Apollo is not running'", () => {
    // Fails with an error; fails but prints a plausible list (including its caller); succeeds with nothing.
    for (const ps of ["echo 'ps: operation not permitted' >&2; exit 1", 'echo "$PPID node install-app.ts"; exit 1', "exit 0"]) {
      const r = withPs(ps);
      expect(r.status, ps).toBe(0);
      expect(r.stdout, ps).toMatch(/Refuse: the process list cannot be read/);
      expect(r.stdout, ps).not.toMatch(/not running/);
    }
  });
  it("a lock whose owner cannot be checked (ps fails) counts as held", () => {
    const dir = tmp("dry");
    mkdirSync(join(dir, "install-app.lock"));
    // This test runner is alive, so only ps can say whether it is install:app; ps fails.
    writeFileSync(join(dir, "install-app.lock", "000000000001.json"), JSON.stringify({ pid: process.pid, startedAt: "x" }));
    expect(withPs("exit 1", dir).stdout).toMatch(new RegExp(`Refuse: the install lock is held by pid ${process.pid}, and whether it still runs cannot be told`));
  });

  it("rejects unknown options before doing anything", () => {
    const r = dryRun(tmp("dry"), "--bogus");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown option --bogus/);
  });
});
