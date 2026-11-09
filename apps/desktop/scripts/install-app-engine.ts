/**
 * The install as a state machine over injected effects (files, SQLite, processes, health,
 * build, clock), so every branch, the destructive ones included, runs in tests against a
 * simulated Mac. install-app.ts supplies the real effects.
 *
 *   lock → [recovery] → db-check → build → wait-idle → quit (confirmed) → snapshot → swap
 *        → relaunch + stays healthy → drop previous → ok
 *
 * Invariants:
 * - Before the quit, any failure leaves Apollo as it was.
 * - Between the quit and the swap, any failure reopens Apollo unchanged.
 * - From the swap on, any failure (a false health check or an exception) rolls back: stop the
 *   new build, previous bundle back, database snapshot back (checked), reopen, check health.
 * - Nothing is opened over a database the build cannot read: if the restore fails, Apollo is
 *   left stopped, the marker stays, and the result says what to do (or rerun to resume).
 * - The marker exists from before the snapshot until bundle and database agree again; while
 *   it exists, a run first finishes or undoes that install.
 * - Result-file writes never fail the install (best effort).
 */
import { join } from "node:path";
import {
  acquireLock,
  bundleSchema,
  checkSchema,
  listSnapshots,
  pruneSnapshots,
  readMarker,
  relaunchUntilHealthy,
  releaseLock,
  restorePrevious,
  restoreSnapshot,
  SNAPSHOTS_KEPT,
  staysHealthy,
  takeSnapshot,
  validateSnapshot,
  waitForIdle,
  writeResult,
  type BuildInfo,
  type Bundles,
  type FileOps,
  type InstallResult,
  type Marker,
  type Options,
  type ResultStatus,
  type SqliteOps,
} from "./install-app-lib.ts";

export interface Proc {
  readonly pid: number;
  readonly kind: "installed" | "development" | "server";
}

export interface Timing {
  readonly relaunchTimeoutMs: number;
  /** Health checks after the first answer, `stableIntervalMs` apart, all of which must pass. */
  readonly stableSamples: number;
  readonly stableIntervalMs: number;
  /** How long Apollo gets to quit by itself. */
  readonly quitGraceMs: number;
  /** Rounds of SIGKILL + check for what is left, `pollMs` apart. */
  readonly killRounds: number;
  readonly pollMs: number;
  readonly idlePollMs: number;
}

export const TIMING: Timing = {
  relaunchTimeoutMs: 2 * 60_000,
  stableSamples: 3,
  stableIntervalMs: 5000,
  quitGraceMs: 30_000,
  killRounds: 10,
  pollMs: 500,
  idlePollMs: 5000,
};

export interface Env {
  readonly bundles: Bundles;
  readonly dbPath: string;
  readonly backupsDir: string;
  readonly markerPath: string;
  readonly lockPath: string;
  readonly resultPath: string;
  readonly logPath: string | null;
  /** The schema the code being installed migrates to. */
  readonly codeSchema: number;
  readonly options: Options;
  readonly pid: number;
  readonly timing: Timing;
}

export interface Deps {
  readonly env: Env;
  readonly files: FileOps;
  readonly sqlite: SqliteOps;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /**
   * Every Apollo process right now (installed app, development run, their servers). Throws
   * when the process list cannot be read: that is never taken to mean "none".
   */
  readonly apollo: () => Array<Proc>;
  /** Asks the apps to quit (bounded in time). */
  readonly requestQuit: (procs: ReadonlyArray<Proc>) => void;
  /** SIGKILL. */
  readonly kill: (pid: number) => void;
  /** Whether a pid is a running install:app (for the lock). Throws when it cannot tell. */
  readonly isInstaller: (pid: number) => boolean;
  /** Sessions mid-turn. */
  readonly busy: () => Array<string>;
  /** Builds the app and stages it at `bundles.staged`. */
  readonly build: () => Promise<BuildInfo>;
  /** `open` the installed app (one attempt). */
  readonly open: () => void;
  /** Whether a server of the installed app answers /health now. */
  readonly healthy: () => Promise<boolean>;
  /** From here on, SIGTERM/SIGHUP/SIGINT are ignored. */
  readonly holdSignals: () => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `<commit>@<builtAt>`: tells this run's build from any other. */
export const bundleIdentity = (files: FileOps, bundle: string): string | null => {
  try {
    const info = JSON.parse(files.readText(join(bundle, "Contents", "Resources", "build-info.json"))) as BuildInfo;
    return `${info.commit}@${info.builtAt}`;
  } catch {
    return null;
  }
};

interface MarkerData extends Marker {
  /** The identity of the build this install puts in place. */
  readonly newBuild: string | null;
}

class Run {
  stage = "start";
  build: BuildInfo | null = null;
  snapshot: string | null = null;
  previousSchema: number | null = null;
  readonly startedAt: string;
  readonly d: Deps;

  constructor(d: Deps) {
    this.d = d;
    this.startedAt = new Date(d.now()).toISOString();
  }

  get b() {
    return this.d.env.bundles;
  }

  private result(status: ResultStatus, error: string | null, manual: string | null): InstallResult {
    return {
      status,
      stage: this.stage,
      build: this.build,
      startedAt: this.startedAt,
      finishedAt: status === "running" ? null : new Date(this.d.now()).toISOString(),
      error,
      manual,
      log: this.d.env.logPath,
      pid: this.d.env.pid,
      snapshot: this.snapshot,
    };
  }

  /** Best effort: a result file that cannot be written must never stop the install or its rollback. */
  record(status: ResultStatus = "running", error: string | null = null, manual: string | null = null) {
    try {
      writeResult(this.d.env.resultPath, this.result(status, error, manual), this.d.files);
    } catch (e) {
      this.d.log(`  (could not write ${this.d.env.resultPath}: ${message(e)})`);
    }
  }

  at(stage: string) {
    this.stage = stage;
    this.d.log(`\n▸ ${stage}  [${new Date(this.d.now()).toISOString()}]`);
    this.record();
  }

  finish(status: Exclude<ResultStatus, "running">, error: string | null = null, manual: string | null = null, write = true): InstallResult {
    if (write) this.record(status, error, manual);
    this.d.log(`\n${status === "ok" ? "✓" : "✗"} install:app ${status} at stage "${this.stage}"${error ? `: ${error}` : ""}`);
    if (manual) this.d.log(`  To fix by hand: ${manual}`);
    if (this.build) this.d.log(`  build: ${this.build.commit.slice(0, 10)}${this.build.dirty ? " (dirty)" : ""}, schema ${this.build.schemaVersion}`);
    if (write) this.d.log(`  result: ${this.d.env.resultPath}`);
    return this.result(status, error, manual);
  }

  /** Required: a marker that cannot be written stops the step that needed it. */
  writeMarker(phase: Marker["phase"]) {
    const data: MarkerData = {
      phase,
      startedAt: this.startedAt,
      pid: this.d.env.pid,
      snapshot: this.snapshot,
      previousSchema: this.previousSchema,
      newBuild: this.build ? `${this.build.commit}@${this.build.builtAt}` : null,
    };
    this.d.files.writeText(this.d.env.markerPath, `${JSON.stringify(data, null, 2)}\n`);
  }

  tryWriteMarker(phase: Marker["phase"]) {
    try {
      this.writeMarker(phase);
    } catch (e) {
      this.d.log(`  (could not update ${this.d.env.markerPath}: ${message(e)})`);
    }
  }

  clearMarker() {
    try {
      this.d.files.remove(this.d.env.markerPath);
    } catch (e) {
      this.d.log(`  (could not remove ${this.d.env.markerPath}: ${message(e)}; the next run will check the install again)`);
    }
  }

  removeStaged() {
    try {
      this.d.files.remove(this.b.staged);
    } catch (e) {
      this.d.log(`  (could not remove ${this.b.staged}: ${message(e)})`);
    }
  }

  /** What to do by hand when the installer stops with Apollo down. */
  manual(extra = ""): string {
    const { b } = this;
    const { dbPath } = this.d.env;
    const parts = ["Apollo was left stopped."];
    if (extra) parts.push(extra);
    if (this.d.files.exists(b.previous)) parts.push(`The previous build is at ${b.previous}: mv ${b.target} ${b.failed} && mv ${b.previous} ${b.target}.`);
    if (this.snapshot)
      parts.push(
        `The database from before the update is ${this.snapshot}/apollo.db (checked when taken): ` +
          `cp ${this.snapshot}/apollo.db ${dbPath} && rm -f ${dbPath}-wal ${dbPath}-shm. Databases it replaced are kept in ${this.snapshot}/replaced-*.`,
      );
    parts.push("Or run install:app again: it resumes from where this stopped.");
    return parts.join(" ");
  }
}

// ---------------------------------------------------------------------------------------
// Steps

/** The Apollo processes, or null when the process list cannot be read. */
const listApollo = (d: Deps): Array<Proc> | null => {
  try {
    return d.apollo();
  } catch (e) {
    d.log(`  (cannot list processes: ${message(e)})`);
    return null;
  }
};

type Stopped = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly pids: ReadonlyArray<number>; readonly asked: boolean };

/**
 * Quits every Apollo process and waits until a readable process list shows none; force-stops
 * stragglers. An unreadable list is never taken as "all stopped".
 */
const stopApollo = async (run: Run): Promise<Stopped> => {
  const { d } = run;
  const t = d.env.timing;
  let procs = listApollo(d);
  if (procs === null) return { ok: false, reason: "the process list cannot be read, so Apollo's processes cannot be confirmed stopped", pids: [], asked: false };
  if (procs.length === 0) return { ok: true };
  d.log(`  Stopping ${procs.map((p) => `${p.kind} ${p.pid}`).join(", ")}`);
  try {
    d.requestQuit(procs);
  } catch (e) {
    d.log(`  (asking Apollo to quit failed: ${message(e)})`);
  }
  // The list is read again each time: a server started during shutdown is caught too.
  const deadline = d.now() + t.quitGraceMs;
  while (((procs = listApollo(d)) === null || procs.length > 0) && d.now() < deadline) await d.sleep(t.pollMs);
  for (let round = 0; round < t.killRounds && ((procs = listApollo(d)) === null || procs.length > 0); round++) {
    for (const p of procs ?? []) {
      d.log(`  ${p.kind} ${p.pid} did not exit: SIGKILL`);
      try {
        d.kill(p.pid);
      } catch (e) {
        d.log(`  (kill ${p.pid} failed: ${message(e)})`);
      }
    }
    await d.sleep(t.pollMs);
  }
  const left = listApollo(d);
  if (left === null) return { ok: false, reason: "the process list cannot be read, so Apollo's processes cannot be confirmed stopped", pids: [], asked: true };
  if (left.length > 0) return { ok: false, reason: `processes ${left.map((p) => p.pid).join(", ")} would not stop`, pids: left.map((p) => p.pid), asked: true };
  return { ok: true };
};

const safeHealthy = (d: Deps) => async () => {
  try {
    return await d.healthy();
  } catch {
    return false;
  }
};

/** Opens until /health answers, then requires it to stay healthy for a while. */
const launchAndVerify = async (run: Run): Promise<boolean> => {
  const { d } = run;
  const t = d.env.timing;
  const healthy = safeHealthy(d);
  const open = () => {
    try {
      d.open();
    } catch (e) {
      d.log(`  (open failed: ${message(e)})`);
    }
  };
  if (!(await relaunchUntilHealthy({ open, healthy, sleep: d.sleep, now: d.now, log: d.log, timeoutMs: t.relaunchTimeoutMs }))) return false;
  d.log(`  /health answers; checking it stays up (${t.stableSamples} × ${t.stableIntervalMs / 1000} s)`);
  const stable = await staysHealthy({ healthy, sleep: d.sleep, samples: t.stableSamples, intervalMs: t.stableIntervalMs });
  if (!stable) d.log("  It stopped answering");
  return stable;
};

type DbOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Makes the database one the installed build can read. With `rollback`, the snapshot from
 * this install goes back regardless (the new build may have changed the database). Otherwise
 * only when the database is newer than `schema`, unreadable, or a restore was interrupted.
 * Every retained snapshot is a candidate, newest first, and each is checked before use.
 */
const restoreDatabase = (
  run: Run,
  schema: number | null,
  o: { readonly rollback: boolean; readonly interrupted: boolean; readonly restoreMissing?: boolean },
): DbOutcome => {
  const { d } = run;
  const { dbPath, backupsDir } = d.env;
  const current = d.sqlite.inspect(dbPath);
  // null: the backups could not be listed. That is never "there are none".
  let retained: Array<string> | null;
  try {
    retained = listSnapshots(backupsDir, d.files).map((s) => s.dir);
  } catch (e) {
    d.log(`  (cannot list snapshots in ${backupsDir}: ${message(e)})`);
    retained = null;
  }
  if (current === null && o.restoreMissing === true && !o.interrupted && retained === null && run.snapshot === null) {
    // Fresh state is only right when there is provably nothing to restore.
    return { ok: false, error: `the database is missing and the snapshots in ${backupsDir} cannot be listed, so it cannot be told whether one should be restored` };
  }
  // A missing database is only "fresh state" when there is nothing to restore.
  const needed =
    current === null
      ? o.interrupted || (o.restoreMissing === true && ((retained?.length ?? 0) > 0 || run.snapshot !== null))
      : o.interrupted || !current.ok || (schema !== null && current.version > schema);
  if (schema === null) d.log("  (the restored build does not say which schema it reads)");
  const candidates = [
    ...(run.snapshot && (o.rollback || needed) ? [run.snapshot] : []),
    ...(needed ? (retained ?? []).filter((dir) => dir !== run.snapshot) : []),
  ];
  for (const dir of candidates) {
    const check = validateSnapshot(dir, d.files, d.sqlite);
    if (!check.ok) {
      d.log(`  Snapshot ${dir} is not usable: ${check.reason}`);
      continue;
    }
    if (schema !== null && check.version > schema) {
      d.log(`  Snapshot ${dir} is at schema ${check.version}, newer than the build (${schema})`);
      continue;
    }
    try {
      const restoring = run.snapshot;
      run.snapshot = dir;
      const { aside } = restoreSnapshot({ snapshotDir: dir, dbPath, now: d.now(), beforeCommit: () => run.writeMarker("restoring-db") }, d.files, d.sqlite);
      d.log(`  Database restored from ${dir} (schema ${check.version}); the one it replaced is in ${aside}`);
      if (restoring && restoring !== dir) d.log(`  (instead of ${restoring})`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `restoring ${dir} failed: ${message(e)}` };
    }
  }
  if (!needed) {
    if (o.rollback && run.snapshot) d.log("  The snapshot could not be used, but the build can read the database as it is: left in place");
    return { ok: true };
  }
  const what = current === null ? "missing" : !current.ok ? "unreadable" : `at schema ${current.version}`;
  if (retained === null) return { ok: false, error: `the database is ${what}, and the snapshots in ${backupsDir} cannot be listed to find one to restore` };
  return { ok: false, error: `the database is ${what} and no checked snapshot the build (schema ${schema ?? "unknown"}) can read exists` };
};

/**
 * Recovery's rule, for every branch: never open a build over a database it cannot read, and
 * prefer a checked snapshot over the fresh state a missing database would give.
 */
const ensureDatabase = (run: Run, schema: number | null, o: { readonly rollback: boolean; readonly interrupted: boolean }): DbOutcome => {
  const { d } = run;
  const unknownSchema = `${run.b.target} does not say which database schema it reads, so it is not opened over`;
  if (schema === null && !d.env.options.force) {
    // Nothing can be checked against an unknown schema: only "no database, and provably
    // nothing to restore" may go ahead without --force. Refuse before changing anything.
    if (d.sqlite.inspect(d.env.dbPath) !== null) return { ok: false, error: `${unknownSchema} the current database (use --force if you know it is compatible)` };
    let nothingToRestore = false;
    try {
      nothingToRestore = run.snapshot === null && listSnapshots(d.env.backupsDir, d.files).length === 0;
    } catch (e) {
      d.log(`  (cannot list snapshots: ${message(e)})`);
    }
    if (!nothingToRestore) return { ok: false, error: `${unknownSchema} a restored snapshot (use --force if you know it is compatible)` };
    return { ok: true };
  }
  const restored = restoreDatabase(run, schema, { ...o, restoreMissing: true });
  if (!restored.ok) return restored;
  // The one gate, on the database that will actually be opened (as it is now, after any restore).
  const final = d.sqlite.inspect(d.env.dbPath);
  if (final === null) return { ok: true };
  if (!final.ok) return { ok: false, error: `the database at ${d.env.dbPath} is not readable` };
  if (schema === null) {
    if (d.env.options.force) {
      d.log(`  ${run.b.target} does not say which schema it reads; opening it over schema ${final.version} anyway (--force)`);
      return { ok: true };
    }
    return { ok: false, error: `${unknownSchema} a database at schema ${final.version} (use --force if you know it is compatible)` };
  }
  if (final.version > schema) return { ok: false, error: `the database is at schema ${final.version}, newer than ${run.b.target} (schema ${schema})` };
  return { ok: true };
};

/** Before the swap (Apollo stopped, nothing moved): put Apollo back as it was. */
const reopenUnchanged = async (run: Run, error: string): Promise<InstallResult> => {
  run.removeStaged();
  run.clearMarker();
  if (run.d.env.options.noOpen) return run.finish("failed", `${error}. Nothing was changed.`);
  run.at("reopen");
  const up = await launchAndVerify(run);
  return up
    ? run.finish("failed", `${error}. Nothing was changed; Apollo is running again.`)
    : run.finish("failed", `${error}. Nothing was changed, but Apollo does not answer /health after reopening.`, `Open ${run.b.target} and check its log.`);
};

type SwapProgress = "none" | "target-moved" | "staged-moved";

/**
 * Back to the previous build after the swap. Never opens anything over a database the
 * previous build cannot read.
 */
const rollback = async (run: Run, reason: string, progress: SwapProgress): Promise<InstallResult> => {
  const { d, b } = run;
  try {
    if (progress === "none") return await reopenUnchanged(run, reason);
    run.at("rollback");
    d.log(`  ${reason}: rolling back`);
    run.tryWriteMarker("rolling-back");
    const stopped = await stopApollo(run);
    if (!stopped.ok) {
      return run.finish(
        "failed",
        `${reason}; ${stopped.reason}, so nothing was rolled back`,
        run.manual(stopped.pids.length > 0 ? `Stop them: kill -9 ${stopped.pids.join(" ")}.` : "Make sure no Apollo process runs (Activity Monitor)."),
      );
    }
    if (d.files.exists(b.previous)) restorePrevious(d.files, b);
    else if (progress === "staged-moved") {
      run.clearMarker();
      return run.finish("failed", `${reason}, and there is no previous build to go back to`, `Fix the build and run install:app again (${b.target} is the new build).`);
    } else {
      return run.finish("failed", `${reason}, and no app bundle is left`, run.manual());
    }
    const db = ensureDatabase(run, run.previousSchema ?? bundleSchema(d.files, b.target), { rollback: true, interrupted: false });
    if (!db.ok) return run.finish("failed", `${reason}; the previous build is back, but ${db.error}. Nothing was opened.`, run.manual());
    run.clearMarker();
    run.at("rollback-relaunch");
    if (await launchAndVerify(run)) return run.finish("rolled-back", reason);
    return run.finish("failed", `${reason}; the previous build is back with its database, but does not answer /health either`, `Open ${b.target} and check its log.`);
  } catch (e) {
    return run.finish("failed", `${reason}; the rollback failed: ${message(e)}. Nothing was opened.`, run.manual());
  }
};

/**
 * An earlier install did not finish (marker present, or no Apollo.app). Finish it if its build
 * is healthy, undo it otherwise. Returns "continue" when everything was already consistent.
 */
const recover = async (run: Run, marker: (Marker & Partial<MarkerData>) | null): Promise<InstallResult | "continue"> => {
  const { d, b } = run;
  const { options } = d.env;
  run.at("recovery");
  run.snapshot = marker?.snapshot ?? null;
  run.previousSchema = marker?.previousSchema ?? null;
  const restoring = marker?.phase === "rolling-back" || marker?.phase === "restoring-db";
  d.log(`  An earlier install did not finish (${marker ? `phase ${marker.phase}, started ${marker.startedAt}` : `${b.target} is missing`}): dealing with it first`);

  const targetIsNew = marker?.newBuild != null && bundleIdentity(d.files, b.target) === marker.newBuild;

  const running = listApollo(d);
  if (running === null) {
    return run.finish("failed", "An earlier install did not finish, and whether Apollo is running cannot be told (the process list cannot be read)", "Run install:app again once `ps` works.");
  }
  if (running.length > 0) {
    // Nothing is moved under a running Apollo. If what runs is consistent and healthy, the
    // earlier install is simply done.
    const schema = bundleSchema(d.files, b.target);
    const db = d.sqlite.inspect(d.env.dbPath);
    const consistent =
      !restoring && d.files.exists(b.target) && schema !== null && (db === null || (db.ok && db.version <= schema)) && (await safeHealthy(d)()) &&
      (await staysHealthy({ healthy: safeHealthy(d), sleep: d.sleep, samples: d.env.timing.stableSamples, intervalMs: d.env.timing.stableIntervalMs }));
    if (!consistent) {
      return run.finish(
        "failed",
        "Apollo is running, but an earlier install did not finish and what runs is not known to be consistent",
        "Quit Apollo, then run install:app again: it finishes or undoes the earlier install first.",
      );
    }
    d.log("  Apollo is running, healthy, with a database its build reads: the earlier install is done");
    if (targetIsNew) {
      try {
        d.files.remove(b.previous);
      } catch (e) {
        d.log(`  (could not remove ${b.previous}: ${message(e)})`);
      }
    }
    run.clearMarker();
    run.snapshot = null;
    return "continue";
  }

  // Bundles and the database may move from here: being interrupted would leave them half done.
  d.holdSignals();
  if (!marker) {
    // No marker (an older installer stopped between two renames): record the recovery before
    // moving anything, so it is resumed until bundle and database agree.
    run.previousSchema = bundleSchema(d.files, b.previous);
    try {
      run.writeMarker("rolling-back");
    } catch (e) {
      return run.finish("failed", `Cannot record the recovery (${message(e)}); nothing was moved`, run.manual());
    }
  }
  let progress: SwapProgress = "none";
  if (!d.files.exists(b.target)) {
    if (!d.files.exists(b.previous)) return run.finish("failed", `No ${b.target} and no previous build to restore`, run.manual("Reinstall Apollo (install:app from a known-good checkout)."));
    d.files.rename(b.previous, b.target);
    d.log(`  Restored ${b.target} from ${b.previous}`);
  } else if (targetIsNew && restoring) {
    if (d.files.exists(b.previous)) restorePrevious(d.files, b);
  } else if (targetIsNew) {
    progress = "staged-moved";
  }
  run.removeStaged();

  if (progress === "staged-moved") {
    // The earlier install's build is in place but was never confirmed: check it now.
    if (options.noOpen) return run.finish("failed", "An earlier install's build is in place but unchecked; run without --no-open to finish it", run.manual());
    const db = ensureDatabase(run, bundleSchema(d.files, b.target), { rollback: false, interrupted: false });
    if (!db.ok) return run.finish("failed", `Recovery: ${db.error}. Nothing was opened.`, run.manual());
    run.at("relaunch");
    if (await launchAndVerify(run)) {
      try {
        d.files.remove(b.previous);
      } catch (e) {
        d.log(`  (could not remove ${b.previous}: ${message(e)})`);
      }
      run.clearMarker();
      run.stage = "resumed";
      return run.finish("ok", "An earlier install was finished (its build is healthy); run install:app again to install this checkout");
    }
    return rollback(run, "The build an earlier install left is not healthy", "staged-moved");
  }

  const schema = bundleSchema(d.files, b.target) ?? run.previousSchema;
  const db = ensureDatabase(run, schema, { rollback: restoring, interrupted: marker?.phase === "restoring-db" });
  if (!db.ok) return run.finish("failed", `Recovery: ${db.error}. Nothing was opened.`, run.manual());
  run.clearMarker();
  run.stage = "recovered";
  if (options.noOpen) return run.finish("rolled-back", "Recovered an interrupted install (not opened: --no-open); run install:app again to update");
  if (await launchAndVerify(run)) return run.finish("rolled-back", "Recovered an interrupted install; run install:app again to update");
  return run.finish("failed", "Recovered an interrupted install, but Apollo does not answer /health", `Open ${b.target} and check its log.`);
};

// ---------------------------------------------------------------------------------------
// The install

const install = async (run: Run): Promise<InstallResult> => {
  const { d, b } = run;
  const { env } = d;
  const { options } = env;

  const marker = readMarker(env.markerPath, d.files) as (Marker & Partial<MarkerData>) | null;
  if (marker || (!d.files.exists(b.target) && d.files.exists(b.previous))) {
    const recovered = await recover(run, marker);
    if (recovered !== "continue") return recovered;
  }

  run.at("db-check");
  const schema = checkSchema(d.sqlite.inspect(env.dbPath)?.version ?? null, env.codeSchema, options.force);
  if (!schema.ok) return run.finish("aborted", schema.message);
  d.log(`  Database: ${schema.note}`);

  run.at("build");
  try {
    run.build = await d.build();
  } catch (e) {
    run.removeStaged();
    return run.finish("failed", `Build failed: ${message(e)}`);
  }
  if (!d.files.exists(b.staged)) return run.finish("failed", `The build did not stage ${b.staged}`);

  // An unreadable process list counts as "running": the wait and the confirmed stop decide.
  if ((listApollo(d)?.length ?? 1) > 0 && !options.now) {
    run.at("wait-idle");
    const idle = await waitForIdle({ busy: d.busy, sleep: d.sleep, now: d.now, log: d.log, timeoutMs: options.waitTimeoutMs, pollMs: env.timing.idlePollMs });
    if (!idle.idle) {
      run.removeStaged();
      return run.finish("aborted", `Bots still busy after ${options.waitTimeoutMs / 60_000} min, Apollo left as it was: ${idle.busy.join("; ")}`);
    }
    d.log("  No bot is working: updating now.");
  }
  const again = checkSchema(d.sqlite.inspect(env.dbPath)?.version ?? null, env.codeSchema, options.force);
  if (!again.ok) {
    run.removeStaged();
    return run.finish("aborted", again.message);
  }

  // From here Apollo goes down: being interrupted would leave it half done.
  d.holdSignals();
  run.at("quit");
  const stopped = await stopApollo(run);
  if (!stopped.ok) {
    run.removeStaged();
    return run.finish(
      "failed",
      `${stopped.reason}; nothing was changed`,
      stopped.asked
        ? `${stopped.pids.length > 0 ? `Stop them (kill -9 ${stopped.pids.join(" ")}), then open` : "Check no Apollo process is left, then open"} ${b.target}.`
        : null,
    );
  }

  try {
    run.at("snapshot");
    run.previousSchema = bundleSchema(d.files, b.target);
    run.writeMarker("swapping");
    const snapshot = takeSnapshot({ dbPath: env.dbPath, backupsDir: env.backupsDir, label: run.build ? `${run.build.commit.slice(0, 10)}${run.build.dirty ? "-dirty" : ""}` : "unknown", now: d.now() }, d.files, d.sqlite);
    run.snapshot = snapshot?.dir ?? null;
    // An old build without build-info read the database it was snapshotted from.
    run.previousSchema ??= snapshot?.dbVersion ?? null;
    run.writeMarker("swapping");
    if (snapshot) {
      d.log(`  Database (schema ${snapshot.dbVersion}) copied to ${snapshot.dir}`);
      try {
        for (const dir of pruneSnapshots(env.backupsDir, SNAPSHOTS_KEPT, [snapshot.dir], d.files)) d.log(`  Removed an older snapshot: ${dir}`);
      } catch (e) {
        d.log(`  (pruning snapshots failed: ${message(e)})`);
      }
    } else d.log("  No database yet: nothing to snapshot");
  } catch (e) {
    return reopenUnchanged(run, `Could not prepare the update: ${message(e)}`);
  }

  let progress: SwapProgress = "none";
  try {
    run.at("swap");
    d.files.remove(b.previous);
    if (d.files.exists(b.target)) {
      d.files.rename(b.target, b.previous);
      progress = "target-moved";
    }
    d.files.rename(b.staged, b.target);
    progress = "staged-moved";
    run.tryWriteMarker("verifying");
    d.log(`  ${b.target} is the new build; the previous one is kept at ${b.previous}`);
    if (options.noOpen) {
      run.clearMarker();
      run.stage = "installed-not-opened";
      return run.finish("ok");
    }
    run.at("relaunch");
    if (!(await launchAndVerify(run))) return await rollback(run, "The new build did not stay healthy", progress);
    run.at("healthy");
    try {
      d.files.remove(b.previous);
    } catch (e) {
      d.log(`  (could not remove ${b.previous}: ${message(e)})`);
    }
    run.clearMarker();
    return run.finish("ok");
  } catch (e) {
    return rollback(run, `Error during the ${run.stage} stage: ${message(e)}`, progress);
  }
};

/** Runs one install under the lock. Never throws. */
export const runInstall = async (d: Deps): Promise<InstallResult> => {
  const run = new Run(d);
  const me = { pid: d.env.pid, startedAt: run.startedAt };
  let lock: ReturnType<typeof acquireLock>;
  try {
    lock = acquireLock(d.env.lockPath, me, d.isInstaller, d.files);
  } catch (e) {
    return run.finish("aborted", `Could not take the install lock: ${message(e)}`, null, false);
  }
  // The result file belongs to the run holding the lock: leave it alone.
  if (!lock.ok) {
    const who = lock.holder ? `pid ${lock.holder.pid}, started ${lock.holder.startedAt}` : "unreadable owner";
    return run.finish(
      "aborted",
      lock.state === "alive"
        ? `Another install:app (${who}) is running; not starting a second one`
        : `The install lock is held (${who}) and whether its owner still runs cannot be told; not starting. If no install:app runs, remove ${d.env.lockPath}`,
      null,
      false,
    );
  }
  if (lock.tookOver) d.log(`  Took over a stale lock (pid ${lock.tookOver.pid} is gone)`);
  try {
    return await install(run);
  } catch (e) {
    // Every stage handles its own failures; this is a backstop.
    return run.finish("failed", `Unexpected error: ${message(e)}`, run.manual());
  } finally {
    releaseLock(d.env.lockPath, lock.generation, me, d.files);
  }
};
