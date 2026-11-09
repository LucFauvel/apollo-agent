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
import {
  listSnapshots,
  parseArgs,
  realFileOps,
  realSqliteOps,
  takeSnapshot,
  type BuildInfo,
  type FileOps,
  type InstallResult,
  type LaunchAttempt,
  type LaunchStrategy,
} from "./install-app-lib.ts";

type Health = "good" | "bad" | "flash" | "dies";
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
    /** Strategies that silently do nothing (as `open` with ELECTRON_RUN_AS_NODE=1 did). */
    dropped: new Set<LaunchStrategy>(),
    /** stderr `open` prints (even with exit 0). */
    openStderr: "",
    launches: [] as Array<LaunchStrategy>,
    /** How the direct exec behaves: starts the app, creates a process that dies at once, or fails to spawn. */
    exec: "launches" as "launches" | "dies" | "enoent",
    apolloCalls: 0,
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
    apollo: () => {
      // A loop that never sleeps would spin on this: fail the test instead of hanging the worker.
      if (++w.apolloCalls > 100_000) throw Object.assign(new Error("runaway: process list read 100000 times"), { runaway: true });
      return [...w.procs];
    },
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
    launch: async (strategy): Promise<LaunchAttempt> => {
      w.opens++;
      w.launches.push(strategy);
      const exe = join(bundles.target, "Contents", "MacOS", "apollo");
      if (strategy === "exec" && w.exec === "enoent") {
        return { strategy, command: exe, args: [], status: null, signal: null, stderr: "", error: `spawn ${exe} ENOENT`, pid: null, spawned: false };
      }
      if (strategy === "exec" && w.exec === "dies") {
        // The process was created (it has a pid) and exited before anyone could look.
        return { strategy, command: exe, args: [], status: 1, signal: null, stderr: "", error: null, pid: 4242, spawned: true };
      }
      const attempt: LaunchAttempt =
        strategy === "exec"
          ? { strategy, command: exe, args: [], status: null, signal: null, stderr: "", error: null, pid: 4242, spawned: true }
          : { strategy, command: "/usr/bin/open", args: strategy === "open-new" ? ["-n", "-a", bundles.target] : ["-a", bundles.target], status: 0, signal: null, stderr: w.openStderr, error: null, pid: null, spawned: false };
      if (w.dropped.has(strategy)) return attempt;
      // LaunchServices dropping requests: only `open` goes through it.
      if (w.swallowOpens > 0 && strategy !== "exec") {
        w.swallowOpens--;
        return attempt;
      }
      if (w.app) return attempt;
      const spec = specOf(bundles.target);
      if (spec) w.start(spec);
      return attempt;
    },
    healthy: async () => {
      if (!w.app) return false;
      w.app.healthCalls++;
      if (w.app.spec.health === "good") return true;
      if (w.app.spec.health === "flash" && w.app.healthCalls === 1) return true;
      if (w.app.spec.health === "flash") w.stop();
      if (w.app?.spec.health === "dies") w.stop();
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
    lock: realFileOps.list(join(data, "install-app.lock")).some((e) => e.endsWith(".json") && !existsSync(join(data, "install-app.lock", e.replace(".json", ".released")))),
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
    // open and open -n are dropped; the direct exec (not LaunchServices) starts it.
    expect(w.launches).toEqual(["open", "open-new", "exec"]);
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
    expect(r.error).toMatch(/the previous build is back with its database, but it launched but did not answer \/health/);
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
    const launch = d.launch;
    const r = await runInstall({
      ...d,
      launch: async (strategy) => {
        const attempt = await launch(strategy);
        if (state().running === "new") {
          w.quitIgnored = true;
          for (const p of w.procs) w.unkillable.add(p.pid);
        }
        return attempt;
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
    const launch = d.launch;
    const r = await runInstall({
      ...d,
      launch: async (strategy) => {
        // Corrupt the snapshot while the new build runs.
        const snap = listSnapshots(join(w.data, "backups"))[0];
        if (snap && state().target === "new") writeFileSync(join(snap.dir, "apollo.db"), "not a SQLite database");
        return launch(strategy);
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
    mkdirSync(join(w.data, "install-app.lock"));
    writeFileSync(join(w.data, "install-app.lock", "1.json"), JSON.stringify({ pid: 77, startedAt: "earlier" }));
    const r = await runInstall(deps());
    expect(r.status).toBe("aborted");
    expect(r.error).toMatch(/pid 77/);
    expect(w.builds).toBe(0);
    expect(existsSync(join(w.data, "logs", "install-app-last.result"))).toBe(false);
    expect(state()).toMatchObject({ target: "old", running: "old", lock: true });
  });

  it("a stale lock (process gone, or no longer an installer) is taken over", async () => {
    const { w, deps } = world({});
    mkdirSync(join(w.data, "install-app.lock"));
    writeFileSync(join(w.data, "install-app.lock", "1.json"), JSON.stringify({ pid: 77, startedAt: "earlier" }));
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

describe("round 3: process list unreadable (ps fails) is never 'nothing runs'", () => {
  it("ps failing before the stop: nothing is stopped, snapshotted or moved", async () => {
    const { w, deps, state } = world({});
    const d = deps();
    const r = await runInstall({ ...d, apollo: () => { throw new Error("ps failed (exit 1)"); } });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/process list cannot be read/);
    expect(state()).toMatchObject({ target: "old", previous: null, staged: false, running: "old", db: 18, marker: null });
    expect(existsSync(join(w.data, "backups"))).toBe(false);
  });

  it("ps failing after the quit: the stop is not confirmed, so no snapshot and no swap", async () => {
    const { w, deps, state } = world({});
    const d = deps();
    let asked = false;
    const r = await runInstall({
      ...d,
      requestQuit: (p) => {
        asked = true;
        d.requestQuit(p);
      },
      apollo: () => {
        if (asked) throw new Error("ps: EPERM");
        return d.apollo();
      },
    });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/cannot be confirmed stopped/);
    expect(state()).toMatchObject({ target: "old", previous: null, staged: false, marker: null });
    expect(existsSync(join(w.data, "backups"))).toBe(false);
  });

  it("an unreadable list before the stop counts as running: busy bots are still waited for", async () => {
    const { w, deps } = world({});
    w.busy = ["Ceres / work (running)"];
    w.busyUntil = 60_000;
    const d = deps();
    let first = true;
    const r = await runInstall({
      ...d,
      apollo: () => {
        if (first) {
          first = false;
          throw new Error("ps: transient");
        }
        return d.apollo();
      },
    });
    expect(r.status).toBe("ok");
    expect(w.t).toBeGreaterThanOrEqual(60_000);
  });

  it("a ps failure while polling that clears up is fine: only the final, readable list decides", async () => {
    const { deps, state } = world({});
    const d = deps();
    let asked = false;
    let fails = 3;
    const r = await runInstall({
      ...d,
      requestQuit: (p) => {
        asked = true;
        d.requestQuit(p);
      },
      apollo: () => {
        if (asked && fails-- > 0) throw new Error("ps: transient");
        return d.apollo();
      },
    });
    expect(r.status).toBe("ok");
    expect(state()).toMatchObject({ target: "new", running: "new" });
  });

  it("ps failing during a rollback: nothing is rolled back over possibly live processes", async () => {
    const { deps, state } = world({ next: { name: "new", schema: 19, health: "bad" } });
    const d = deps();
    const r = await runInstall({ ...d, apollo: () => (state().running === "new" ? (() => { throw new Error("ps: gone"); })() : d.apollo()) });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/cannot be confirmed stopped, so nothing was rolled back/);
    expect(state()).toMatchObject({ target: "new", previous: "old", marker: "rolling-back" });
  });

  it("ps failing during recovery: refuses, nothing moved", async () => {
    const env = world({ installed: null, previous: { name: "old", schema: 18, health: "good" }, db: 18, running: false });
    const d = env.deps();
    const r = await runInstall({ ...d, apollo: () => { throw new Error("ps failed"); } });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/cannot be told/);
    expect(env.state()).toMatchObject({ target: null, previous: "old" });
  });
});

describe("round 3: a pending new build is checked against the database before it opens", () => {
  /** Swap done, then the installer died before confirming health. */
  const pending = (o: { db: number | null; snapshot?: number; health?: "good" | "bad"; corruptDb?: boolean }) => {
    const env = world({ running: false, db: o.snapshot ?? 18 });
    const { w, makeBundle } = env;
    const snap = o.snapshot !== undefined ? takeSnapshot({ dbPath: w.dbPath, backupsDir: join(w.data, "backups"), label: "pre", now: 50 })! : null;
    realFileOps.remove(w.dbPath);
    if (o.db !== null) makeDb(w.dbPath, o.db);
    if (o.corruptDb) writeFileSync(w.dbPath, "torn ".repeat(500));
    const info = makeBundle(w.bundles.staged, { name: "new", schema: 19, health: o.health ?? "good" });
    realFileOps.rename(w.bundles.target, w.bundles.previous);
    realFileOps.rename(w.bundles.staged, w.bundles.target);
    writeFileSync(
      join(w.data, "install-app.pending.json"),
      JSON.stringify({ phase: "verifying", startedAt: "x", pid: 9, snapshot: snap?.dir ?? null, previousSchema: 18, newBuild: `${info.commit}@${info.builtAt}` }),
    );
    return env;
  };
  const rows = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return (db.prepare("select v from t").all() as Array<{ v: number }>).map((r) => r.v);
    } finally {
      db.close();
    }
  };

  it("database newer than the new build, no snapshot it can read: not opened, marker kept", async () => {
    const { w, deps, state } = pending({ db: 20 });
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/Nothing was opened/);
    expect(w.opens).toBe(0);
    expect(state()).toMatchObject({ target: "new", previous: "old", running: null, db: 20, marker: "verifying" });
  });

  it("database newer than the new build, with a checked schema-18 snapshot: restored first, then opened", async () => {
    const { w, deps, state } = pending({ db: 20, snapshot: 18 });
    const r = await runInstall(deps());
    expect(r).toMatchObject({ status: "ok", stage: "resumed" });
    expect(w.logs.some((l) => /Database restored from/.test(l))).toBe(true);
    expect(state()).toMatchObject({ target: "new", running: "new", db: 19, marker: null });
  });

  it("database missing, snapshot available: the snapshot is restored, not fresh state", async () => {
    const { w, deps, state } = pending({ db: null, snapshot: 18 });
    expect((await runInstall(deps())).status).toBe("ok");
    expect(rows(w.dbPath)).toContain(18);
    expect(state()).toMatchObject({ running: "new", db: 19 });
  });

  it("database unreadable: restored from the snapshot before opening", async () => {
    const { w, deps } = pending({ db: 18, snapshot: 18, corruptDb: true });
    expect((await runInstall(deps())).status).toBe("ok");
    expect(rows(w.dbPath)).toContain(18);
  });

  it("an older build without build-info in place is not opened over a database without --force", async () => {
    const env = world({ running: false, db: 18 });
    const { w, makeBundle } = env;
    const info = makeBundle(w.bundles.staged, { name: "new", schema: 19, health: "good", info: false });
    realFileOps.rename(w.bundles.target, w.bundles.previous);
    realFileOps.rename(w.bundles.staged, w.bundles.target);
    // Identity from a build-info that is not in the bundle: the marker cannot match, so this is the "old" branch.
    writeFileSync(join(w.data, "install-app.pending.json"), JSON.stringify({ phase: "verifying", startedAt: "x", pid: 9, snapshot: null, previousSchema: null, newBuild: `${info.commit}@${info.builtAt}` }));
    const r = await runInstall(env.deps());
    expect(r.status).toBe("failed");
    expect(w.opens).toBe(0);
  });
});

describe("round 3: marker-less recovery stays resumable", () => {
  it("records a marker before moving anything; the retry still recovers once a snapshot is there", async () => {
    const env = world({ installed: null, previous: { name: "old", schema: 18, health: "good" }, db: 19, running: false });
    const { w, deps, state } = env;
    const first = await runInstall(deps());
    expect(first.status).toBe("failed");
    expect(state()).toMatchObject({ target: "old", running: null, db: 19, marker: "rolling-back" });
    // A usable snapshot becomes available; the build is broken: the retry must not need it.
    const src = join(w.root, "src");
    mkdirSync(src);
    makeDb(join(src, "apollo.db"), 18);
    takeSnapshot({ dbPath: join(src, "apollo.db"), backupsDir: join(w.data, "backups"), label: "s", now: 7 });
    const d = deps(2);
    const second = await runInstall({ ...d, build: async () => Promise.reject(new Error("no build")) });
    expect(second.status).toBe("rolled-back");
    expect(state()).toMatchObject({ target: "old", running: "old", db: 18, marker: null });
  });

  it("an old bundle without build-info: refused, the marker kept, and --force on the retry finishes the recovery", async () => {
    const env = world({ installed: null, previous: { name: "old", schema: 18, health: "good", info: false }, db: 18, running: false });
    expect((await runInstall(env.deps())).status).toBe("failed");
    expect(env.state()).toMatchObject({ target: "old", marker: "rolling-back" });
    const forced = await runInstall({ ...env.deps(2), env: { ...env.deps(2).env, options: parseArgs(["--force"]) } });
    expect(forced.status).toBe("rolled-back");
    expect(env.w.builds).toBe(0);
    expect(env.state()).toMatchObject({ running: "old", marker: null });
  });

  it("a marker that cannot be recorded: nothing is moved", async () => {
    const env = world({ installed: null, previous: { name: "old", schema: 18, health: "good" }, db: 18, running: false });
    env.w.faults.push((op, [path]) => op === "writeText" && path!.endsWith("pending.json"));
    expect((await runInstall(env.deps())).status).toBe("failed");
    expect(env.state()).toMatchObject({ target: null, previous: "old" });
  });
});

describe("round 3: malformed snapshot metadata is skipped, not fatal", () => {
  it("a newest snapshot with a malformed manifest does not stop older ones being used", async () => {
    const env = world({ installed: null, previous: { name: "old", schema: 18, health: "good" }, db: 19, running: false });
    const { w, deps, state } = env;
    const backups = join(w.data, "backups");
    for (const [i, version] of [18, 18].entries()) {
      const src = join(w.root, `m-${i}`);
      mkdirSync(src);
      makeDb(join(src, "apollo.db"), version);
      takeSnapshot({ dbPath: join(src, "apollo.db"), backupsDir: backups, label: `m${i}`, now: 10 + i });
    }
    // Newest: valid JSON, no fields (and a round-1 style manifest would lack `file` the same way).
    writeFileSync(join(listSnapshots(backups)[0]!.dir, "snapshot.json"), "{}");
    const r = await runInstall(deps());
    expect(r.status).toBe("rolled-back");
    expect(w.logs.some((l) => /malformed/.test(l))).toBe(true);
    expect(state()).toMatchObject({ running: "old", db: 18 });
  });
});

describe("round 4: reviewer round-3 repros (acceptance)", () => {
  it("P1-2: a legacy build (no build-info) is not opened over a restored newer snapshot without --force; the marker stays", async () => {
    // No active DB, no Apollo.app, previous = legacy schema-18 build without build-info,
    // a valid retained schema-20 snapshot, no --force.
    const env = world({ installed: null, previous: { name: "old", schema: 18, health: "good", info: false }, db: null, running: false });
    const { w, deps, state } = env;
    const src = join(w.root, "s20");
    mkdirSync(src);
    makeDb(join(src, "apollo.db"), 20);
    takeSnapshot({ dbPath: join(src, "apollo.db"), backupsDir: join(w.data, "backups"), label: "s", now: 1 });
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/does not say which database schema it reads/);
    expect(r.manual).toBeTruthy();
    expect(w.opens).toBe(0);
    expect(state()).toMatchObject({ target: "old", running: null, marker: "rolling-back" });
    // The override is explicit: with --force the same state is opened.
    const forced = await runInstall({ ...deps(2), env: { ...deps(2).env, options: parseArgs(["--force"]) } });
    expect(forced.status).toBe("rolled-back");
    expect(state()).toMatchObject({ running: "old", marker: null });
  });

  it("P1-2: the same gate holds when the snapshot is restored onto a build that declares an older schema", async () => {
    const env = world({ installed: null, previous: { name: "old", schema: 18, health: "good" }, db: null, running: false });
    const src = join(env.w.root, "s20");
    mkdirSync(src);
    makeDb(join(src, "apollo.db"), 20);
    takeSnapshot({ dbPath: join(src, "apollo.db"), backupsDir: join(env.w.data, "backups"), label: "s", now: 1 });
    const r = await runInstall(env.deps());
    expect(r.status).toBe("failed");
    expect(env.w.opens).toBe(0);
    expect(env.state()).toMatchObject({ marker: "rolling-back" });
  });

  it("P1-3: snapshots that cannot be listed are not 'no snapshots': nothing is opened, fresh state is not created, the marker stays", async () => {
    // Pending new schema-19 build matching the marker, previous old schema-18, active DB missing,
    // a valid retained schema-18 snapshot, marker phase verifying with no snapshot; listing the
    // backups directory fails with EACCES.
    const env = world({ running: false, db: 18 });
    const { w, makeBundle, deps, state } = env;
    const backups = join(w.data, "backups");
    takeSnapshot({ dbPath: w.dbPath, backupsDir: backups, label: "pre", now: 50 });
    realFileOps.remove(w.dbPath);
    const info = makeBundle(w.bundles.staged, { name: "new", schema: 19, health: "good" });
    realFileOps.rename(w.bundles.target, w.bundles.previous);
    realFileOps.rename(w.bundles.staged, w.bundles.target);
    writeFileSync(
      join(w.data, "install-app.pending.json"),
      JSON.stringify({ phase: "verifying", startedAt: "x", pid: 9, snapshot: null, previousSchema: 18, newBuild: `${info.commit}@${info.builtAt}` }),
    );
    w.faults.push((op, [path]) => op === "list" && path === backups);
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/cannot be listed/);
    expect(r.manual).toBeTruthy();
    expect(w.opens).toBe(0);
    expect(state()).toMatchObject({ target: "new", previous: "old", running: null, db: null, marker: "verifying" });
    // Once the directory is readable, the retry restores the snapshot rather than starting fresh.
    w.faults.length = 0;
    const again = await runInstall(deps(2));
    expect(again).toMatchObject({ status: "ok", stage: "resumed" });
    expect(w.logs.some((l) => /Database restored from/.test(l))).toBe(true);
    expect(state()).toMatchObject({ running: "new", db: 19, marker: null });
  });

  it("P1-3: an unreadable backup list with a database present and compatible changes nothing about it", async () => {
    const { w, deps, state } = world({});
    w.faults.push((op, [path]) => op === "list" && path === join(w.data, "backups"));
    // Normal install: pruning cannot list either, which is only logged.
    expect((await runInstall(deps())).status).toBe("ok");
    expect(state()).toMatchObject({ target: "new", running: "new" });
  });
});

describe("round 4: the gate checks the database actually opened, on every branch", () => {
  it("a database that changes between the restore decision and the open is caught by the final check", async () => {
    const env = world({ running: false, db: 18 });
    const { w, makeBundle, deps, state } = env;
    const info = makeBundle(w.bundles.staged, { name: "new", schema: 19, health: "good" });
    realFileOps.rename(w.bundles.target, w.bundles.previous);
    realFileOps.rename(w.bundles.staged, w.bundles.target);
    writeFileSync(join(w.data, "install-app.pending.json"), JSON.stringify({ phase: "verifying", startedAt: "x", pid: 9, snapshot: null, previousSchema: 18, newBuild: `${info.commit}@${info.builtAt}` }));
    const d = deps();
    let reads = 0;
    // The first look sees schema 18; by the time it is about to open, something wrote schema 20.
    const sqlite = { ...d.sqlite, inspect: (p: string) => (p === w.dbPath && ++reads >= 2 ? { version: 20, ok: true } : d.sqlite.inspect(p)) };
    const r = await runInstall({ ...d, sqlite });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/schema 20, newer than/);
    expect(w.opens).toBe(0);
    expect(state()).toMatchObject({ marker: "verifying" });
  });

  it("an in-run rollback to a legacy build (no build-info) is not opened over the database the new build created", async () => {
    // Not running and no database before: nothing tells which schema the old build reads.
    const { w, deps, state } = world({ installed: { name: "old", schema: 18, health: "good", info: false }, db: null, running: false, next: { name: "new", schema: 19, health: "bad" } });
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/does not say which database schema it reads/);
    expect(state()).toMatchObject({ target: "old", running: null, db: 19, marker: "rolling-back" });
    // Only the new build was ever opened.
    expect(w.opens).toBeGreaterThan(0);
  });
});

describe("relaunch: strategies, and launched vs never launched", () => {
  it("escalates open → open -n → the executable when nothing launches, and records every attempt", async () => {
    const { w, deps, state, result } = world({});
    w.dropped = new Set(["open", "open-new"]);
    w.openStderr = "LSOpenURLsWithRole() failed with error -600";
    const r = await runInstall(deps());
    expect(r.status).toBe("ok");
    expect(w.launches).toEqual(["open", "open-new", "exec"]);
    expect(state()).toMatchObject({ target: "new", running: "new" });
    const launches = result().launches;
    expect(launches.map((a) => [a.strategy, a.launched])).toEqual([
      ["open", false],
      ["open-new", false],
      ["exec", true],
    ]);
    expect(launches[0]).toMatchObject({ command: "/usr/bin/open", args: ["-a", w.bundles.target], status: 0, stderr: "LSOpenURLsWithRole() failed with error -600" });
    expect(launches[1]!.args).toEqual(["-n", "-a", w.bundles.target]);
    // stderr is kept in the log even though open exited 0.
    expect(w.logs.some((l) => /launch 1: open: \/usr\/bin\/open -a .*exit 0; stderr: LSOpenURLsWithRole/.test(l))).toBe(true);
  });

  it("a build that launches but never answers is rolled back after one launch, not relaunched again and again", async () => {
    const { w, deps, state } = world({ next: { name: "new", schema: 19, health: "bad" } });
    const d = deps();
    let rollbackAt = 0;
    let launchedAt = 0;
    const r = await runInstall({
      ...d,
      launch: async (strategy) => {
        const a = await d.launch(strategy);
        if (state().running === "new" && !launchedAt) launchedAt = w.t;
        return a;
      },
      log: (line) => {
        if (!rollbackAt && /rolling back/.test(line)) rollbackAt = w.t;
        d.log(line);
      },
    });
    expect(r.status).toBe("rolled-back");
    expect(r.error).toMatch(/launched but did not answer \/health/);
    // One launch of the new build, one of the old one.
    expect(w.launches).toEqual(["open", "open"]);
    expect(rollbackAt - launchedAt).toBeLessThanOrEqual(TIMING.startupGraceMs + 2000);
    expect(state()).toMatchObject({ target: "old", running: "old" });
  });

  it("a build that exits right after launching is rolled back at once, without waiting out the grace", async () => {
    const { w, deps, state } = world({ next: { name: "new", schema: 19, health: "dies" } });
    const d = deps();
    let rollbackAt = 0;
    let launchedAt = 0;
    const r = await runInstall({
      ...d,
      launch: async (strategy) => {
        const a = await d.launch(strategy);
        if (state().running === "new" && !launchedAt) launchedAt = w.t;
        return a;
      },
      log: (line) => {
        if (!rollbackAt && /rolling back/.test(line)) rollbackAt = w.t;
        d.log(line);
      },
    });
    expect(r.status).toBe("rolled-back");
    expect(w.launches.filter((x, i) => i === 0 || x !== "open")).toEqual(["open"]);
    expect(rollbackAt - launchedAt).toBeLessThan(5000);
  });

  it("nothing launches at all: rolled back, and both failures say so, with every attempt in the result", async () => {
    const { w, deps, result } = world({});
    w.dropped = new Set(["open", "open-new"]);
    w.exec = "enoent";
    const r = await runInstall(deps());
    expect(r.status).toBe("failed");
    // Why it never launched travels with the failure: the last attempt, ENOENT included.
    expect(r.error).toMatch(/The new build is not healthy: it never launched \(\d+ attempt\(s\): open → open-new → exec; last: exec: .*error: spawn .*ENOENT.*nothing launched\).*previous build is back with its database, but it never launched/);
    const attempts = result().launches;
    expect(attempts.filter((a) => a.strategy === "exec").every((a) => /ENOENT/.test(a.error ?? ""))).toBe(true);
    expect(attempts.length).toBeGreaterThanOrEqual(6);
    expect(attempts.every((a) => a.launched === false)).toBe(true);
    // Bounded: about one attempt per launch window, per relaunch budget.
    expect(attempts.length).toBeLessThanOrEqual(2 * (TIMING.relaunchTimeoutMs / TIMING.launchWindowMs + 1));
  });
});

describe("relaunch review: exec evidence and errors", () => {
  it("an exec'd build that dies before anyone looks is 'launched but unhealthy': rolled back at once, not relaunched", async () => {
    const { w, deps, state, result } = world({ next: { name: "new", schema: 19, health: "good" } });
    // LaunchServices does nothing for the new build; its executable starts and dies at once.
    const d = deps();
    let rollbackLogged = false;
    const r = await runInstall({
      ...d,
      launch: async (strategy) => {
        const target = state().target;
        w.dropped = target === "new" ? new Set(["open", "open-new"]) : new Set();
        w.exec = target === "new" ? "dies" : "launches";
        return d.launch(strategy);
      },
      log: (line) => {
        if (/rolling back/.test(line)) rollbackLogged = true;
        d.log(line);
      },
    });
    expect(rollbackLogged).toBe(true);
    expect(r.status).toBe("rolled-back");
    expect(r.error).toMatch(/launched but did not answer/);
    // One exec of the new build, then the old build's launch: no more exec attempts.
    expect(w.launches).toEqual(["open", "open-new", "exec", "open"]);
    const exec = result().launches.find((a) => a.strategy === "exec")!;
    expect(exec).toMatchObject({ spawned: true, pid: 4242, status: 1, launched: true });
    expect(state()).toMatchObject({ target: "old", running: "old" });
  });

  it("an exec that cannot spawn records why, in the log and the result", async () => {
    const { w, deps, result } = world({});
    w.dropped = new Set(["open", "open-new"]);
    w.exec = "enoent";
    await runInstall(deps());
    const exec = result().launches.find((a) => a.strategy === "exec")!;
    expect(exec).toMatchObject({ spawned: false, launched: false, error: expect.stringMatching(/ENOENT/) });
    expect(w.logs.some((l) => /launch \d+: exec: .*error: spawn .*ENOENT.*nothing launched/.test(l))).toBe(true);
  });
});
