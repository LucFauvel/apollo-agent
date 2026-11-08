/**
 * The whole install, destructive branches included, against a simulated Mac: bundles are
 * directories in a temporary "Applications", the database is a real SQLite file in a
 * temporary data directory, and the app, its processes, `open`, /health and the clock are
 * fakes. File operations can be made to fail (ENOSPC, interrupted restores...).
 * Nothing here touches /Applications, ~/.apollo or a running Apollo.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runInstall, TIMING, type Deps, type Proc } from "./install-app-engine.ts";
import { listSnapshots, parseArgs, realFileOps, realSqliteOps, takeSnapshot, type BuildInfo, type FileOps, type InstallResult } from "./install-app-lib.ts";

type Health = "good" | "bad" | "flash";
interface Spec {
  readonly name: string;
  readonly schema: number;
  readonly health: Health;
  /** Whether build-info.json is in the bundle (builds from before this installer have none). */
  readonly info?: boolean;
}

type Fault = (op: keyof FileOps, args: ReadonlyArray<string>) => boolean;

const makeDb = (path: string, version: number) => {
  const db = new DatabaseSync(path);
  db.exec(`create table if not exists t (v integer); insert into t values (${version}); pragma user_version = ${version}`);
  db.close();
};
const dbVersion = (path: string) => realSqliteOps.inspect(path)?.version ?? null;

const world = (o: {
  readonly installed?: Spec | null;
  readonly previous?: Spec;
  readonly next?: Spec;
  readonly db?: number | null;
  readonly running?: boolean;
  readonly argv?: ReadonlyArray<string>;
  readonly codeSchema?: number;
}) => {
  const root = mkdtempSync(join(tmpdir(), "install-engine-"));
  const apps = join(root, "Applications");
  const data = join(root, "data");
  mkdirSync(apps);
  mkdirSync(data);
  const bundles = { target: join(apps, "Apollo.app"), staged: join(apps, ".Apollo-update.app"), previous: join(apps, ".Apollo-previous.app"), failed: join(apps, ".Apollo-failed.app") };
  const dbPath = join(data, "apollo.db");
  let builtAt = 0;
  const makeBundle = (path: string, spec: Spec): BuildInfo => {
    const info: BuildInfo = { commit: `${spec.name}-commit`, dirty: false, branch: "test", schemaVersion: spec.schema, builtAt: `t${++builtAt}` };
    mkdirSync(join(path, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(path, "Contents", "spec.json"), JSON.stringify(spec));
    if (spec.info !== false) writeFileSync(join(path, "Contents", "Resources", "build-info.json"), JSON.stringify(info));
    return info;
  };
  const specOf = (path: string): Spec | null => (existsSync(join(path, "Contents", "spec.json")) ? (JSON.parse(readFileSync(join(path, "Contents", "spec.json"), "utf8")) as Spec) : null);

  if (o.installed !== null) makeBundle(bundles.target, o.installed ?? { name: "old", schema: 18, health: "good" });
  if (o.previous) makeBundle(bundles.previous, o.previous);
  if (o.db !== null) makeDb(dbPath, o.db ?? 18);

  // --- processes and the app
  let nextPid = 1000;
  const w = {
    root,
    apps,
    data,
    bundles,
    dbPath,
    procs: [] as Array<Proc>,
    app: null as { spec: Spec; healthCalls: number } | null,
    opens: 0,
    swallowOpens: 0,
    quitIgnored: false,
    respawnOnQuit: false,
    unkillable: new Set<number>(),
    busy: [] as Array<string>,
    busyUntil: Infinity,
    installers: new Set<number>(),
    builds: 0,
    faults: [] as Array<Fault>,
    logs: [] as Array<string>,
    t: 0,
    sleeps: 0,
    next: o.next ?? ({ name: "new", schema: 19, health: "good" } as Spec),
    start(spec: Spec) {
      w.app = { spec, healthCalls: 0 };
      w.procs.push({ pid: nextPid++, kind: "installed" }, { pid: nextPid++, kind: "server" });
      // The new build migrates the database when it starts.
      const v = existsSync(dbPath) ? dbVersion(dbPath) : null;
      if (v === null || v < spec.schema) makeDb(dbPath, spec.schema);
    },
    stop() {
      w.app = null;
      w.procs = w.procs.filter((p) => w.unkillable.has(p.pid));
    },
  };
  if (o.running !== false && o.installed !== null) w.start(specOf(bundles.target)!);

  const faulty = (op: keyof FileOps) =>
    ((...args: Array<string>) => {
      if (w.faults.some((f) => f(op, args))) throw Object.assign(new Error(`${op} ${args.join(" ")}: ENOSPC (injected)`), { code: "ENOSPC" });
      return (realFileOps[op] as (...a: Array<string>) => unknown)(...args);
    }) as never;
  const files = Object.fromEntries(Object.keys(realFileOps).map((k) => [k, faulty(k as keyof FileOps)])) as unknown as FileOps;

  const deps = (pid = 1): Deps => ({
    env: {
      bundles,
      dbPath,
      backupsDir: join(data, "backups"),
      markerPath: join(data, "install-app.pending.json"),
      lockPath: join(data, "install-app.lock"),
      resultPath: join(data, "logs", "install-app-last.result"),
      logPath: null,
      codeSchema: o.codeSchema ?? w.next.schema,
      options: parseArgs([...(o.argv ?? [])]),
      pid,
      timing: TIMING,
    },
    files,
    sqlite: realSqliteOps,
    now: () => w.t,
    sleep: async (ms) => {
      if (++w.sleeps > 200_000) throw new Error("runaway loop");
      w.t += ms;
      if (w.t >= w.busyUntil) w.busy = [];
    },
    log: (line) => void w.logs.push(line),
    apollo: () => [...w.procs],
    requestQuit: () => {
      if (w.quitIgnored) return;
      w.stop();
      if (w.respawnOnQuit) {
        w.respawnOnQuit = false;
        w.procs.push({ pid: nextPid++, kind: "server" });
      }
    },
    kill: (pid) => {
      if (w.unkillable.has(pid)) return;
      w.procs = w.procs.filter((p) => p.pid !== pid);
      if (!w.procs.some((p) => p.kind === "installed")) w.app = null;
    },
    isInstaller: (p) => w.installers.has(p),
    busy: () => w.busy,
    build: async () => {
      w.builds++;
      return makeBundle(bundles.staged, w.next);
    },
    open: () => {
      w.opens++;
      if (w.swallowOpens > 0) return void w.swallowOpens--;
      if (w.app) return;
      const spec = specOf(bundles.target);
      if (spec) w.start(spec);
    },
    healthy: async () => {
      if (!w.app) return false;
      w.app.healthCalls++;
      if (w.app.spec.health === "good") return true;
      if (w.app.spec.health === "flash" && w.app.healthCalls === 1) return true;
      if (w.app.spec.health === "flash") w.stop();
      return false;
    },
    holdSignals: () => {},
  });

  const state = () => ({
    target: specOf(bundles.target)?.name ?? null,
    previous: specOf(bundles.previous)?.name ?? null,
    failed: specOf(bundles.failed)?.name ?? null,
    staged: existsSync(bundles.staged),
    running: w.app?.spec.name ?? null,
    db: existsSync(dbPath) ? dbVersion(dbPath) : null,
    marker: existsSync(join(data, "install-app.pending.json")) ? (JSON.parse(readFileSync(join(data, "install-app.pending.json"), "utf8")) as { phase: string }).phase : null,
    lock: existsSync(join(data, "install-app.lock")),
  });
  const result = () => JSON.parse(readFileSync(join(data, "logs", "install-app-last.result"), "utf8")) as InstallResult;
  return { w, deps, state, result, makeBundle };
};

const isRestoreCommit: Fault = (op, args) => op === "rename" && /\.restore-\d+\/apollo\.db$/.test(args[0] ?? "");

describe("install: the normal path", () => {
  it("builds, waits, stops, snapshots, swaps, verifies health over time, drops the previous build", async () => {
    const { w, deps, state, result } = world({});
    w.busy = ["Ceres / work (running)"];
    w.busyUntil = 60_000;
    const r = await runInstall(deps());
    expect(r).toMatchObject({ status: "ok", stage: "healthy" });
    expect(state()).toEqual({ target: "new", previous: null, failed: null, staged: false, running: "new", db: 19, marker: null, lock: false });
    expect(w.t).toBeGreaterThanOrEqual(60_000);
    expect(result()).toMatchObject({ status: "ok", build: { commit: "new-commit", schemaVersion: 19 } });
    // The snapshot is the database as the old build left it.
    const [snap] = listSnapshots(join(w.data, "backups"));
    expect(snap).toMatchObject({ dbVersion: 18 });
    expect(result().snapshot).toBe(snap!.dir);
  });

  it("retries `open` when the first ones do nothing (LaunchServices after a force-quit)", async () => {
    const { w, deps, state } = world({});
    w.swallowOpens = 4;
    expect((await runInstall(deps())).status).toBe("ok");
    expect(w.opens).toBe(5);
    expect(state().running).toBe("new");
  });

  it("--no-open keeps the previous build and clears the marker", async () => {
    const { deps, state } = world({ argv: ["--no-open"] });
    expect(await runInstall(deps())).toMatchObject({ status: "ok", stage: "installed-not-opened" });
    expect(state()).toMatchObject({ target: "new", previous: "old", running: null, marker: null });
  });

  it("a result file that cannot be written never stops the install", async () => {
    const { w, deps, state } = world({});
    w.faults.push((op, [path]) => op === "writeText" && path!.endsWith(".result"));
    expect((await runInstall(deps())).status).toBe("ok");
    expect(state()).toMatchObject({ target: "new", running: "new", marker: null });
  });
});

describe("install: refusing before anything changes", () => {
  it("a database newer than the code: aborted before building", async () => {
    const { w, deps, state } = world({ db: 20 });
    expect((await runInstall(deps())).status).toBe("aborted");
    expect(w.builds).toBe(0);
    expect(state()).toMatchObject({ target: "old", running: "old", db: 20 });
  });

  it("bots still busy after --wait-timeout: aborted, staged build removed, app untouched", async () => {
    const { w, deps, state, result } = world({ argv: ["--wait-timeout", "1"] });
    w.busy = ["Ceres / long (running, ses_1)"];
    const r = await runInstall(deps());
    expect(r.status).toBe("aborted");
    expect(r.error).toMatch(/Ceres \/ long/);
    expect(state()).toMatchObject({ target: "old", running: "old", staged: false, marker: null });
    expect(result().status).toBe("aborted");
  });

  it("--now does not wait", async () => {
    const { w, deps } = world({ argv: ["--now"] });
    w.busy = ["Ceres / long (running)"];
    expect((await runInstall(deps())).status).toBe("ok");
  });

  it("a failed build leaves the app as it was", async () => {
    const { deps, state } = world({});
    const d = deps();
    const r = await runInstall({ ...d, build: async () => Promise.reject(new Error("tsc failed")) });
    expect(r).toMatchObject({ status: "failed" });
    expect(state()).toMatchObject({ target: "old", running: "old", staged: false });
  });
});

describe("install: stopping Apollo (P1-5)", () => {
  it("processes that survive quit and SIGKILL: nothing is snapshotted or moved", async () => {
    const { w, deps, state } = world({});
    w.quitIgnored = true;
    const server = w.procs.find((p) => p.kind === "server")!.pid;
    w.unkillable.add(server);
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(new RegExp(`${server}.*would not stop`));
    expect(state()).toMatchObject({ target: "old", previous: null, staged: false, marker: null });
    expect(existsSync(join(w.data, "backups"))).toBe(false);
  });

  it("an app that ignores quit is force-stopped, and a server started during shutdown is caught too", async () => {
    const { w, deps } = world({});
    w.respawnOnQuit = true;
    expect((await runInstall(deps())).status).toBe("ok");
    expect(w.logs.some((l) => /server \d+ did not exit: SIGKILL/.test(l))).toBe(true);
  });

  it("a quit request that throws still ends in a confirmed stop", async () => {
    const { deps } = world({});
    const d = deps();
    expect((await runInstall({ ...d, requestQuit: () => { throw new Error("osascript timed out"); } })).status).toBe("ok");
  });
});

describe("install: rollback (P1-1, P2a)", () => {
  it("a build that never gets healthy: previous bundle and database back, opened, healthy", async () => {
    const { w, deps, state, result } = world({ next: { name: "new", schema: 19, health: "bad" } });
    const r = await runInstall(deps());
    expect(r).toMatchObject({ status: "rolled-back" });
    // The new build had migrated the database to 19; the old one gets its 18 back.
    expect(state()).toEqual({ target: "old", previous: null, failed: "new", staged: false, running: "old", db: 18, marker: null, lock: false });
    expect(result().status).toBe("rolled-back");
    expect(w.logs.some((l) => /Database restored from/.test(l))).toBe(true);
  });

  it("one /health answer then death is not success: the previous build is still there to go back to", async () => {
    const { deps, state } = world({ next: { name: "new", schema: 19, health: "flash" } });
    expect((await runInstall(deps())).status).toBe("rolled-back");
    expect(state()).toMatchObject({ target: "old", failed: "new", running: "old", db: 18 });
  });

  it("an exception after the swap rolls back instead of reopening the new build", async () => {
    const { w, deps, state } = world({});
    // The second half of the swap fails: the old app is at .Apollo-previous.app, no Apollo.app.
    w.faults.push((op, [from]) => op === "rename" && from === w.bundles.staged);
    const r = await runInstall(deps());
    expect(r.status).toBe("rolled-back");
    expect(state()).toMatchObject({ target: "old", running: "old", db: 18, marker: null });
  });

  it("a health check that throws once is just a failed sample, not a reason to roll back", async () => {
    const { deps, state } = world({});
    const d = deps();
    let thrown = false;
    const r = await runInstall({
      ...d,
      healthy: async () => {
        if (state().running === "new" && !thrown) {
          thrown = true;
          throw new Error("ECONNRESET");
        }
        return d.healthy();
      },
    });
    expect(r.status).toBe("ok");
    expect(state()).toMatchObject({ target: "new", running: "new" });
  });

  it("health checks that throw count as unhealthy, and roll back", async () => {
    const { deps, state } = world({});
    const d = deps();
    const r = await runInstall({ ...d, healthy: async () => (state().running === "new" ? Promise.reject(new Error("socket")) : d.healthy()) });
    expect(r.status).toBe("rolled-back");
    expect(state()).toMatchObject({ target: "old", running: "old" });
  });

  it("the rollback works even when no result file can be written", async () => {
    const { w, deps, state } = world({ next: { name: "new", schema: 19, health: "bad" } });
    w.faults.push((op, [path]) => op === "writeText" && path!.endsWith(".result"));
    expect((await runInstall(deps())).status).toBe("rolled-back");
    expect(state()).toMatchObject({ target: "old", running: "old", db: 18 });
  });

  it("a previous build that is not healthy either: reported, with bundle and database back", async () => {
    const { deps, state } = world({ installed: { name: "old", schema: 18, health: "bad" }, running: false, next: { name: "new", schema: 19, health: "bad" } });
    const r = await runInstall(deps());
    expect(r).toMatchObject({ status: "failed" });
    expect(r.error).toMatch(/does not answer \/health either/);
    expect(state()).toMatchObject({ target: "old", db: 18, marker: null });
  });

  it("a first install that is not healthy has nothing to go back to", async () => {
    const { deps, state } = world({ installed: null, db: null, next: { name: "new", schema: 19, health: "bad" } });
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/no previous build/);
    expect(state()).toMatchObject({ target: "new", marker: null });
  });

  it("a new build whose processes will not stop: nothing is rolled back over them, marker kept", async () => {
    const { w, deps, state } = world({ next: { name: "new", schema: 19, health: "bad" } });
    const d = deps();
    const open = d.open;
    const r = await runInstall({
      ...d,
      open: () => {
        open();
        if (state().running === "new") {
          w.quitIgnored = true;
          for (const p of w.procs) w.unkillable.add(p.pid);
        }
      },
    });
    expect(r.status).toBe("failed");
    expect(r.manual).toMatch(/kill -9/);
    expect(state()).toMatchObject({ target: "new", previous: "old", running: "new", marker: "rolling-back" });
  });
});

describe("install: database restore failures (P1-2)", () => {
  it("an interrupted restore opens nothing, keeps a database in place and the marker; the next run finishes it", async () => {
    const { w, deps, state, result } = world({ next: { name: "new", schema: 19, health: "bad" } });
    w.faults.push(isRestoreCommit);
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/Nothing was opened/);
    expect(r.manual).toMatch(/cp .*pre-update-.*apollo\.db/);
    expect(result().manual).toBe(r.manual);
    const s = state();
    expect(s).toMatchObject({ target: "old", running: null, marker: "restoring-db" });
    expect(s.db).not.toBeNull();
    // The database it was replacing is kept aside, whole.
    const snap = listSnapshots(join(w.data, "backups"))[0]!;
    const aside = readdirSync(snap.dir).find((e) => e.startsWith("replaced-"))!;
    expect(dbVersion(join(snap.dir, aside, "apollo.db"))).toBe(19);

    w.faults.length = 0;
    const again = await runInstall(deps(2));
    expect(again.status).toBe("rolled-back");
    expect(state()).toMatchObject({ target: "old", running: "old", db: 18, marker: null });
  });

  it("a restore that fails before committing leaves the migrated database, opens nothing; rerun recovers", async () => {
    const { w, deps, state } = world({ next: { name: "new", schema: 19, health: "bad" } });
    w.faults.push((op, [, to]) => op === "copy" && /\.restore-\d+\/apollo\.db$/.test(to ?? ""));
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    expect(state()).toMatchObject({ target: "old", running: null, db: 19, marker: "rolling-back" });
    w.faults.length = 0;
    expect((await runInstall(deps(2))).status).toBe("rolled-back");
    expect(state()).toMatchObject({ running: "old", db: 18, marker: null });
  });

  it("a corrupt pre-update snapshot is refused; with no other usable one nothing is opened", async () => {
    const { w, deps, state } = world({ next: { name: "new", schema: 19, health: "bad" } });
    const d = deps();
    const open = d.open;
    const r = await runInstall({
      ...d,
      open: () => {
        // Corrupt the snapshot while the new build runs.
        const snap = listSnapshots(join(w.data, "backups"))[0];
        if (snap && state().target === "new") writeFileSync(join(snap.dir, "apollo.db"), "not a SQLite database");
        open();
      },
    });
    expect(r.status).toBe("failed");
    expect(w.logs.some((l) => /does not match its recorded SHA-256/.test(l))).toBe(true);
    expect(state()).toMatchObject({ target: "old", running: null, db: 19 });
  });
});

describe("recovery (P1-3)", () => {
  /** A crash mid-rollback: old bundle at .Apollo-previous.app, no Apollo.app, database migrated to 19. */
  const crashed = (o: { snapshots: Array<{ version: number; corrupt?: boolean }>; phase?: string; markerSnapshot?: number }) => {
    const env = world({ installed: null, previous: { name: "old", schema: 18, health: "good" }, db: 19, running: false });
    const backups = join(env.w.data, "backups");
    const dirs = o.snapshots.map((s, i) => {
      mkdirSync(join(env.w.root, `src-${i}`));
      const src = join(env.w.root, `src-${i}`, "apollo.db");
      makeDb(src, s.version);
      const snap = takeSnapshot({ dbPath: src, backupsDir: backups, label: `s${i}`, now: 100 + i })!;
      if (s.corrupt) writeFileSync(join(snap.dir, "apollo.db"), "garbage");
      return snap.dir;
    });
    if (o.phase) {
      writeFileSync(
        join(env.w.data, "install-app.pending.json"),
        JSON.stringify({ phase: o.phase, startedAt: "x", pid: 9, snapshot: o.markerSnapshot === undefined ? null : dirs[o.markerSnapshot], previousSchema: 18, newBuild: "new-commit@t9" }),
      );
    }
    return { ...env, dirs };
  };

  it("restores the bundle and a compatible snapshot, opens it, and stops", async () => {
    const { w, deps, state } = crashed({ snapshots: [{ version: 18 }], phase: "rolling-back", markerSnapshot: 0 });
    const events: Array<string> = [];
    w.faults.push((op) => {
      if (op === "rename") events.push("rename");
      return false;
    });
    const r = await runInstall({ ...deps(), holdSignals: () => void events.push("hold") });
    expect(events[0]).toBe("hold");
    expect(r.status).toBe("rolled-back");
    expect(w.builds).toBe(0);
    expect(state()).toMatchObject({ target: "old", running: "old", db: 18, marker: null });
  });

  it("scans every snapshot: a newest one that is corrupt or too new does not hide an older usable one", async () => {
    const { deps, state } = crashed({ snapshots: [{ version: 18 }, { version: 19 }, { version: 18, corrupt: true }], phase: "rolling-back" });
    expect((await runInstall(deps())).status).toBe("rolled-back");
    expect(state()).toMatchObject({ running: "old", db: 18 });
  });

  it("no snapshot the restored build can read: nothing is opened, the marker stays, and the next run still recovers", async () => {
    const { w, deps, state } = crashed({ snapshots: [{ version: 19 }], phase: "rolling-back" });
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/Nothing was opened/);
    expect(state()).toMatchObject({ target: "old", running: null, db: 19, marker: "rolling-back" });
    // Apollo.app exists now; the marker still sends the next run into recovery.
    const again = await runInstall(deps(2));
    expect(again.stage).toBe("recovery");
    expect(again.status).toBe("failed");
    expect(w.builds).toBe(0);
  });

  it("refuses while Apollo is running and the state is not known to be consistent", async () => {
    const { w, deps, state } = crashed({ snapshots: [{ version: 18 }], phase: "rolling-back" });
    w.start({ name: "something", schema: 18, health: "good" });
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    expect(r.manual).toMatch(/Quit Apollo/);
    expect(state()).toMatchObject({ target: null, previous: "old", marker: "rolling-back" });
  });

  it("refuses while Apollo is running mid-rollback, even if it looks healthy and consistent", async () => {
    const { w, deps, state } = world({ db: 18 });
    writeFileSync(join(w.data, "install-app.pending.json"), JSON.stringify({ phase: "restoring-db", startedAt: "x", pid: 9, snapshot: null, previousSchema: 18, newBuild: "zzz" }));
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    expect(w.builds).toBe(0);
    expect(state()).toMatchObject({ target: "old", running: "old", marker: "restoring-db" });
  });

  it("a crash before the old app was moved back (no marker): the bundle comes back and the database is checked", async () => {
    const { deps, state } = crashed({ snapshots: [{ version: 18 }] });
    // previous has build-info (schema 18); the database is at 19: the snapshot goes back.
    expect((await runInstall(deps())).status).toBe("rolled-back");
    expect(state()).toMatchObject({ target: "old", running: "old", db: 18 });
  });

  it("an old bundle without build-info over an existing database is not opened unless --force", async () => {
    const env = world({ installed: null, previous: { name: "old", schema: 18, health: "good", info: false }, db: 18, running: false });
    expect((await runInstall(env.deps())).status).toBe("failed");
    expect(env.state()).toMatchObject({ target: "old", running: null });
    const forced = world({ installed: null, previous: { name: "old", schema: 18, health: "good", info: false }, db: 18, running: false, argv: ["--force"] });
    expect((await runInstall(forced.deps())).status).toBe("rolled-back");
  });

  it("an interrupted install whose new build is in place: checked, and finished if healthy", async () => {
    const { w, deps, state, makeBundle } = world({ running: false });
    // Simulate: swap done, then the installer died. The marker names the new build.
    const info = makeBundle(w.bundles.staged, { name: "new", schema: 19, health: "good" });
    w.faults.length = 0;
    realFileOps.rename(w.bundles.target, w.bundles.previous);
    realFileOps.rename(w.bundles.staged, w.bundles.target);
    writeFileSync(
      join(w.data, "install-app.pending.json"),
      JSON.stringify({ phase: "verifying", startedAt: "x", pid: 9, snapshot: null, previousSchema: 18, newBuild: `${info.commit}@${info.builtAt}` }),
    );
    const r = await runInstall(deps());
    expect(r).toMatchObject({ status: "ok", stage: "resumed" });
    expect(state()).toMatchObject({ target: "new", previous: null, running: "new", marker: null });
  });

  it("an interrupted install whose new build is in place but unhealthy: rolled back", async () => {
    const { w, deps, state, makeBundle } = world({ running: false });
    const info = makeBundle(w.bundles.staged, { name: "new", schema: 19, health: "bad" });
    const snap = takeSnapshot({ dbPath: w.dbPath, backupsDir: join(w.data, "backups"), label: "x", now: 5 })!;
    realFileOps.rename(w.bundles.target, w.bundles.previous);
    realFileOps.rename(w.bundles.staged, w.bundles.target);
    writeFileSync(
      join(w.data, "install-app.pending.json"),
      JSON.stringify({ phase: "swapping", startedAt: "x", pid: 9, snapshot: snap.dir, previousSchema: 18, newBuild: `${info.commit}@${info.builtAt}` }),
    );
    expect((await runInstall(deps())).status).toBe("rolled-back");
    expect(state()).toMatchObject({ target: "old", running: "old", db: 18, marker: null });
  });

  it("Apollo running, consistent and healthy with a leftover marker: the marker is cleared and the install goes on", async () => {
    const { w, deps, state } = world({});
    writeFileSync(join(w.data, "install-app.pending.json"), JSON.stringify({ phase: "verifying", startedAt: "x", pid: 9, snapshot: null, previousSchema: 18, newBuild: "zzz" }));
    expect((await runInstall(deps())).status).toBe("ok");
    expect(state()).toMatchObject({ target: "new", running: "new", marker: null });
  });
});

describe("one install at a time (P1-4)", () => {
  it("a live installer's lock refuses a second run, which touches nothing (not even the result file)", async () => {
    const { w, deps, state } = world({});
    w.installers.add(77);
    writeFileSync(join(w.data, "install-app.lock"), JSON.stringify({ pid: 77, startedAt: "earlier" }));
    const r = await runInstall(deps());
    expect(r.status).toBe("aborted");
    expect(r.error).toMatch(/pid 77/);
    expect(w.builds).toBe(0);
    expect(existsSync(join(w.data, "logs", "install-app-last.result"))).toBe(false);
    expect(state()).toMatchObject({ target: "old", running: "old", lock: true });
  });

  it("a stale lock (process gone, or no longer an installer) is taken over", async () => {
    const { w, deps } = world({});
    writeFileSync(join(w.data, "install-app.lock"), JSON.stringify({ pid: 77, startedAt: "earlier" }));
    expect((await runInstall(deps())).status).toBe("ok");
    expect(w.logs.some((l) => /stale lock \(pid 77/.test(l))).toBe(true);
  });

  it("two overlapping runs: the second is refused and the first's rollback bundle survives", async () => {
    const { w, deps, state } = world({ next: { name: "new", schema: 19, health: "bad" } });
    w.installers.add(1);
    w.installers.add(2);
    const [a, b] = await Promise.all([runInstall(deps(1)), runInstall(deps(2))]);
    expect(b.status).toBe("aborted");
    expect(a.status).toBe("rolled-back");
    expect(state()).toMatchObject({ target: "old", running: "old", db: 18, lock: false });
  });
});

describe("before the swap (snapshot failures)", () => {
  it("a snapshot that cannot be written: Apollo reopened unchanged, marker cleared", async () => {
    const { w, deps, state } = world({});
    w.faults.push((op, [from]) => op === "copy" && from === w.dbPath);
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/Nothing was changed; Apollo is running again/);
    expect(state()).toMatchObject({ target: "old", previous: null, staged: false, running: "old", db: 18, marker: null });
  });

  it("a marker that cannot be written: same, nothing changed", async () => {
    const { w, deps, state } = world({});
    w.faults.push((op, [path]) => op === "writeText" && path!.endsWith("pending.json"));
    expect((await runInstall(deps())).status).toBe("failed");
    expect(state()).toMatchObject({ target: "old", running: "old", marker: null });
  });
});
