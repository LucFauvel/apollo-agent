/**
 * The apply step, as the install engine (src/install/engine.ts) run by a detached helper
 * process: the app cannot replace and health-check itself, so it stages the verified bundle,
 * writes a job file and starts the helper (helper.ts) on its own Electron binary in Node mode.
 * The helper runs the very engine install:app uses (same lock, same pending-install marker, so
 * the two never race and each finishes or undoes the other's interrupted install):
 *
 *   lock → [recovery] → db-check → "build" (= copy the app's private verified bundle to the
 *   shared staged path and check the copy is this release) →
 *   wait for idle bots → quit Apollo → database snapshot → swap → relaunch → stays healthy →
 *   drop previous  |  any failure after the swap → previous bundle + snapshot back → relaunch
 *
 * The shared staged path (`.Apollo-update.app`, also install:app's) is only ever written by
 * whoever holds the install lock: the app verifies the release into a PRIVATE directory under
 * userData (`job.source`) and never touches the shared path; the helper copies it there in the
 * engine's build step, which runs under the lock. So neither installer can swap in a bundle the
 * other staged.
 *
 * This file is the testable core: the job format, the engine's Deps from injected effects,
 * and how the app reads the outcome afterwards (classifyOutcome). No Electron imports.
 */
import { dirname, join } from "node:path";
import { TIMING, type Deps, type Proc } from "../install/engine.ts";
import type { BuildInfo, Bundles, FileOps, LaunchAttempt, LaunchStrategy, SqliteOps } from "../install/lib.ts";

export const JOB_FORMAT = 1;

export interface UpdateJob {
  readonly format: typeof JOB_FORMAT;
  readonly id: string;
  readonly createdAt: number;
  readonly version: string;
  readonly build: number;
  readonly commit: string;
  readonly schemaVersion: number;
  readonly bundles: Bundles;
  /** The verified Apollo.app the app unpacked, in its private `<userData>/updates/work/` directory. */
  readonly source: string;
  /** Evidence of how far the helper got, written by the helper (see Progress). */
  readonly progressPath: string;
  /** Apollo's data directory (the database, its snapshots, the shared install lock and marker). */
  readonly dataDir: string;
  /** The engine's result file (in userData). */
  readonly resultPath: string;
  readonly logPath: string;
  /** How long to wait for bots mid-turn before giving up (Apollo then stays as it is). */
  readonly waitTimeoutMs: number;
  readonly teamId: string;
}

/** The bundle layout next to an app at `target` (`…/Apollo.app`): the same names install:app uses. */
export const bundlesFor = (target: string): Bundles => {
  const dir = target.slice(0, target.lastIndexOf("/"));
  return { target, staged: `${dir}/.Apollo-update.app`, previous: `${dir}/.Apollo-previous.app`, failed: `${dir}/.Apollo-failed.app` };
};

/** Parses and checks a job file; throws on anything off (the helper then changes nothing). */
export const parseJob = (text: string): UpdateJob => {
  const j = JSON.parse(text) as Partial<UpdateJob>;
  const fail = (why: string): never => {
    throw new Error(`invalid update job: ${why}`);
  };
  if (j.format !== JOB_FORMAT) fail("unknown format");
  if (typeof j.id !== "string" || !/^[\w-]{1,64}$/.test(j.id)) fail("id");
  if (!Number.isSafeInteger(j.createdAt)) fail("createdAt");
  if (typeof j.version !== "string" || !j.version) fail("version");
  if (!Number.isSafeInteger(j.build) || j.build! < 1) fail("build");
  if (typeof j.commit !== "string" || !/^[0-9a-f]{40}$/.test(j.commit)) fail("commit");
  if (!Number.isSafeInteger(j.schemaVersion)) fail("schemaVersion");
  const target = j.bundles?.target;
  if (typeof target !== "string" || !target.startsWith("/") || !target.endsWith("/Apollo.app")) fail("bundles.target");
  // Only the four fixed names next to the app: the job can never point the swap anywhere else.
  if (JSON.stringify(j.bundles) !== JSON.stringify(bundlesFor(target!))) fail("bundles");
  for (const key of ["dataDir", "resultPath", "logPath", "progressPath", "source"] as const) if (typeof j[key] !== "string" || !j[key]!.startsWith("/") || j[key]!.includes("/../")) fail(key);
  // The source is the app's own private copy, never one of the shared bundle paths.
  if (!j.source!.startsWith(`${dirname(j.resultPath!)}/work/`) || !j.source!.endsWith("/Apollo.app")) fail("source");
  if (!Number.isSafeInteger(j.waitTimeoutMs) || j.waitTimeoutMs! <= 0) fail("waitTimeoutMs");
  if (typeof j.teamId !== "string" || !/^[A-Z0-9]{10}$/.test(j.teamId)) fail("teamId");
  return j as UpdateJob;
};

/** An own data property; never runs getters or reads inherited (`__proto__`) values. */
const ownProperty = (o: unknown, key: string): unknown => {
  if (typeof o !== "object" || o === null) return undefined;
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d && "value" in d ? d.value : undefined;
};

/** Every way the staged bundle's build-info.json disagrees with the job (the signed manifest). */
export const stagedProblems = (info: unknown, job: Pick<UpdateJob, "version" | "build" | "commit" | "schemaVersion">): Array<string> => {
  // The bundle's metadata is untrusted input: own data properties of exact types only, never
  // coerced (an object with `toString: null` must not throw), and never a throw out of here.
  try {
    if (typeof info !== "object" || info === null || Array.isArray(info)) return ["the staged bundle has no readable build-info.json"];
    const show = (v: unknown) => (typeof v === "string" || typeof v === "number" ? JSON.stringify(v) : typeof v);
    const expected: Array<[string, unknown]> = [
      ["commit", job.commit],
      ["version", job.version],
      ["bundleVersion", String(job.build)],
      ["schemaVersion", job.schemaVersion],
      ["channel", "release"],
    ];
    return expected.flatMap(([key, want]) => {
      const got = ownProperty(info, key);
      return got === want ? [] : [`${key} ${show(got)} != ${JSON.stringify(want)}`];
    });
  } catch {
    return ["the staged bundle's build-info.json cannot be read"];
  }
};

/** The real-world effects the engine needs, injected (helper.ts gives the real ones). */
export interface HelperEffects {
  readonly files: FileOps;
  readonly sqlite: SqliteOps;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly apollo: () => Array<Proc>;
  readonly requestQuit: (procs: ReadonlyArray<Proc>) => void;
  readonly kill: (pid: number) => void;
  readonly isInstaller: (pid: number) => boolean;
  readonly busy: (dbPath: string) => Array<string>;
  readonly launch: (target: string, strategy: LaunchStrategy) => Promise<LaunchAttempt>;
  readonly healthy: (target: string) => Promise<boolean>;
  readonly holdSignals: () => void;
  /** Copies a bundle (ditto): `to` does not exist. */
  readonly copyBundle: (from: string, to: string) => Promise<void>;
  /** null when the bundle's code signature is valid and from the team; else why not. */
  readonly checkSignature: (bundle: string, teamId: string) => Promise<string | null>;
  readonly pid: number;
}

/**
 * How far the helper got, as evidence for classifyOutcome (written by the helper as it goes):
 *  - swapStarted: the previous bundle was moved aside and the new build is being renamed into
 *    the app's place. Recorded durably before that rename, which is refused if it cannot be;
 *  - checksFailed: the staged copy is not this release, or its code signature is invalid.
 * Only these make a build "skipped for good"; a stage name alone never does (the engine records
 * the `swap` stage before its first move).
 */
export interface Progress {
  readonly jobId: string;
  /**
   * The old bundle was moved aside and the new one is being renamed into its place. Written
   * BEFORE that rename, and the rename does not happen unless it was written: so a swap can
   * never have happened without this durable record, whatever fails or dies afterwards.
   */
  readonly swapStarted: boolean;
  /** The rename completed (best effort, for the log; swapStarted is the evidence). */
  readonly swapped: boolean;
  readonly checksFailed: boolean;
}

/**
 * Starts the error of a failed staged check. The engine copies it into the result file, so the
 * failure is on record even if the progress file could not be written.
 */
export const STAGED_CHECK_FAILED = "staged check failed: ";

/** The engine's dependencies for one update job. */
export const helperDeps = (job: UpdateJob, fx: HelperEffects): Deps => {
  const dbPath = join(job.dataDir, "apollo.db");
  let progress: Progress = { jobId: job.id, swapStarted: false, swapped: false, checksFailed: false };
  /** Writes the progress file; with `required`, a failed write throws (the step does not happen). */
  const record = (change: Partial<Progress>, required = false) => {
    const before = progress;
    progress = { ...progress, ...change };
    try {
      fx.files.writeText(job.progressPath, `${JSON.stringify(progress)}\n`);
    } catch (e) {
      if (required) progress = before;
      if (required) throw new Error(`cannot record the update's progress, so the new build is not put in place: ${e instanceof Error ? e.message : String(e)}`);
      fx.log(`  (could not record progress: ${e instanceof Error ? e.message : String(e)})`);
    }
  };
  record({});
  const { staged, target } = job.bundles;
  const files: FileOps = {
    ...fx.files,
    rename: (from, to) => {
      const swap = from === staged && to === target;
      // Evidence first: a swap that is not durably recorded does not happen (the engine then
      // rolls back to the previous bundle it has just moved aside).
      if (swap) record({ swapStarted: true }, true);
      fx.files.rename(from, to);
      if (swap) record({ swapped: true });
    },
  };
  const check = async (): Promise<BuildInfo> => {
    let info: unknown = null;
    try {
      info = JSON.parse(fx.files.readText(join(staged, "Contents", "Resources", "build-info.json"))) as unknown;
    } catch {
      info = null;
    }
    const problems = stagedProblems(info, job);
    if (problems.length > 0) {
      record({ checksFailed: true });
      throw new Error(`${STAGED_CHECK_FAILED}the staged bundle is not release ${job.version}: ${problems.join("; ")}`);
    }
    const signature = await fx.checkSignature(staged, job.teamId);
    if (signature) {
      record({ checksFailed: true });
      throw new Error(`${STAGED_CHECK_FAILED}the staged bundle's code signature is not valid: ${signature}`);
    }
    return info as BuildInfo;
  };
  return {
    env: {
      bundles: job.bundles,
      dbPath,
      backupsDir: join(job.dataDir, "backups"),
      // Shared with install:app on purpose (see the header).
      markerPath: join(job.dataDir, "install-app.pending.json"),
      lockPath: join(job.dataDir, "install-app.lock"),
      resultPath: job.resultPath,
      logPath: job.logPath,
      codeSchema: job.schemaVersion,
      options: { detach: false, now: false, waitTimeoutMs: job.waitTimeoutMs, force: false, dryRun: false, noOpen: false, detachedChild: true },
      pid: fx.pid,
      timing: TIMING,
    },
    files,
    sqlite: fx.sqlite,
    now: fx.now,
    sleep: fx.sleep,
    log: fx.log,
    apollo: fx.apollo,
    requestQuit: fx.requestQuit,
    kill: fx.kill,
    isInstaller: fx.isInstaller,
    busy: () => fx.busy(dbPath),
    // The engine calls this holding the install lock: only now is the shared staged path ours.
    // Stage the app's private verified copy there, then check the copy is exactly this release.
    build: async () => {
      if (!fx.files.exists(job.source)) throw new Error(`the verified update is missing from ${job.source}`);
      fx.files.remove(staged);
      await fx.copyBundle(job.source, staged);
      return check();
    },
    launch: (strategy) => fx.launch(target, strategy),
    healthy: () => fx.healthy(target),
    holdSignals: fx.holdSignals,
  };
};

// ---------------------------------------------------------------------------------------
// Reading the outcome back. Everything read here comes from files that may be damaged:
// parsed without ever throwing, keeping only fields of exactly the expected type.

const own = (o: unknown, key: string): unknown => {
  if (typeof o !== "object" || o === null) return undefined;
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d && "value" in d ? d.value : undefined;
};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The parts of the engine's result file the outcome depends on. */
export interface ResultSummary {
  readonly status: string;
  readonly stage: string;
  readonly startedAt: string;
  readonly error: string | null;
  /** The commit of the build the run installed (null when it never got to the build step). */
  readonly commit: string | null;
}

/** From the engine's result JSON (text or object); null when it is not one. Never throws. */
export const summarizeResult = (raw: unknown): ResultSummary | null => {
  try {
    const r = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    const status = str(own(r, "status"));
    const stage = str(own(r, "stage"));
    const startedAt = str(own(r, "startedAt"));
    if (status === null || stage === null || startedAt === null) return null;
    return { status, stage, startedAt, error: str(own(r, "error")), commit: str(own(own(r, "build"), "commit")) };
  } catch {
    return null;
  }
};

/** The helper's progress file for `jobId`; null when missing, damaged or another job's. Never throws. */
export const parseProgress = (text: string | null, jobId: string): Progress | null => {
  try {
    if (typeof text !== "string") return null;
    const p: unknown = JSON.parse(text);
    if (own(p, "jobId") !== jobId) return null;
    return { jobId, swapStarted: own(p, "swapStarted") === true, swapped: own(p, "swapped") === true, checksFailed: own(p, "checksFailed") === true };
  } catch {
    return null;
  }
};

export type Outcome =
  /** The helper still runs: look again later. */
  | { readonly kind: "pending" }
  | { readonly kind: "updated" }
  /** skip: the build itself is bad here (it was put in place and failed, or failed its checks). */
  | { readonly kind: "failed"; readonly skip: boolean; readonly reason: string }
  /** Nothing changed (bots stayed busy, another install held the lock): may be offered again. */
  | { readonly kind: "postponed"; readonly reason: string };

/**
 * What became of `job`, read by whichever app runs afterwards (the new one, or the old one
 * after a rollback). A build is skipped for good only on evidence the helper recorded: it was
 * renamed into place and the app is not running it, or its staged copy failed the checks.
 * An install interrupted or failing before that is not held against the build.
 */
export const classifyOutcome = (
  job: Pick<UpdateJob, "build" | "commit" | "createdAt">,
  result: ResultSummary | null,
  progress: Progress | null,
  runningBuild: number | null,
  helperAlive: boolean,
): Outcome => {
  if (helperAlive) return { kind: "pending" };
  if (runningBuild === job.build) return { kind: "updated" };
  const startedAt = result ? Date.parse(result.startedAt) : Number.NaN;
  const mine = result !== null && Number.isFinite(startedAt) && startedAt >= job.createdAt - 1000;
  const ours = mine && result.commit === job.commit;
  // Evidence the build itself is bad: it was being put in place (recorded before the rename),
  // or its staged copy failed the checks (recorded in the progress file, or, should that write
  // have failed, in the error the engine wrote to the result).
  const evidence =
    (progress !== null && (progress.swapStarted || progress.swapped || progress.checksFailed)) ||
    (result !== null && mine && result.status === "failed" && result.stage === "build" && (result.error ?? "").includes(STAGED_CHECK_FAILED));
  if (!mine) return { kind: "failed", skip: evidence, reason: "the update helper did not finish" };
  if (result.status === "aborted") return { kind: "postponed", reason: result.error ?? "the update did not start" };
  if (result.status === "ok") {
    // Installed and healthy, yet this app is not that build: e.g. an earlier interrupted install
    // was finished instead (not ours), or another install replaced it since.
    return { kind: "failed", skip: false, reason: ours ? "the update was installed, but another build runs now" : "an earlier, interrupted install was finished first; try again" };
  }
  // The evidence is this job's own (bound to its id), whether or not the result names the build:
  // a staged copy that failed its checks never got as far as the result's build field.
  if (result.status === "running") return { kind: "failed", skip: evidence, reason: `the update stopped during "${result.stage}"` };
  // failed / rolled-back
  return { kind: "failed", skip: evidence, reason: result.error ?? (ours ? `failed during "${result.stage}"` : "an earlier, interrupted install was dealt with first; try again") };
};
