/**
 * The apply step, as the install engine (src/install/engine.ts) run by a detached helper
 * process: the app cannot replace and health-check itself, so it stages the verified bundle,
 * writes a job file and starts the helper (helper.ts) on its own Electron binary in Node mode.
 * The helper runs the very engine install:app uses (same lock, same pending-install marker, so
 * the two never race and each finishes or undoes the other's interrupted install):
 *
 *   lock → [recovery] → db-check → "build" (= check the staged bundle is this release) →
 *   wait for idle bots → quit Apollo → database snapshot → swap → relaunch → stays healthy →
 *   drop previous  |  any failure after the swap → previous bundle + snapshot back → relaunch
 *
 * This file is the testable core: the job format, the engine's Deps from injected effects,
 * and how the app reads the outcome afterwards (classifyOutcome). No Electron imports.
 */
import { join } from "node:path";
import { TIMING, type Deps, type Proc } from "../install/engine.ts";
import type { BuildInfo, Bundles, FileOps, InstallResult, LaunchAttempt, LaunchStrategy, SqliteOps } from "../install/lib.ts";

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
  for (const key of ["dataDir", "resultPath", "logPath"] as const) if (typeof j[key] !== "string" || !j[key]!.startsWith("/")) fail(key);
  if (!Number.isSafeInteger(j.waitTimeoutMs) || j.waitTimeoutMs! <= 0) fail("waitTimeoutMs");
  if (typeof j.teamId !== "string" || !/^[A-Z0-9]{10}$/.test(j.teamId)) fail("teamId");
  return j as UpdateJob;
};

/** Every way the staged bundle's build-info.json disagrees with the job (the signed manifest). */
export const stagedProblems = (info: Partial<BuildInfo> | null, job: Pick<UpdateJob, "version" | "build" | "commit" | "schemaVersion">): Array<string> => {
  if (!info) return ["the staged bundle has no readable build-info.json"];
  const problems: Array<string> = [];
  if (info.commit !== job.commit) problems.push(`commit ${String(info.commit)} != ${job.commit}`);
  if (info.version !== job.version) problems.push(`version ${String(info.version)} != ${job.version}`);
  if (info.bundleVersion !== String(job.build)) problems.push(`build ${String(info.bundleVersion)} != ${job.build}`);
  if (info.schemaVersion !== job.schemaVersion) problems.push(`schema ${String(info.schemaVersion)} != ${job.schemaVersion}`);
  if (info.channel !== "release") problems.push(`channel ${String(info.channel)} != release`);
  return problems;
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
  /** null when the bundle's code signature is valid and from the team; else why not. */
  readonly checkSignature: (bundle: string, teamId: string) => Promise<string | null>;
  readonly pid: number;
}

/** The engine's dependencies for one update job. */
export const helperDeps = (job: UpdateJob, fx: HelperEffects): Deps => {
  const dbPath = join(job.dataDir, "apollo.db");
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
    files: fx.files,
    sqlite: fx.sqlite,
    now: fx.now,
    sleep: fx.sleep,
    log: fx.log,
    apollo: fx.apollo,
    requestQuit: fx.requestQuit,
    kill: fx.kill,
    isInstaller: fx.isInstaller,
    busy: () => fx.busy(dbPath),
    // Nothing is built: the app staged the verified release. Check it is still exactly that.
    build: async () => {
      const { staged } = job.bundles;
      if (!fx.files.exists(staged)) throw new Error(`nothing staged at ${staged}`);
      let info: Partial<BuildInfo> | null = null;
      try {
        info = JSON.parse(fx.files.readText(join(staged, "Contents", "Resources", "build-info.json"))) as Partial<BuildInfo>;
      } catch {
        info = null;
      }
      const problems = stagedProblems(info, job);
      if (problems.length > 0) throw new Error(`the staged bundle is not release ${job.version}: ${problems.join("; ")}`);
      const signature = await fx.checkSignature(staged, job.teamId);
      if (signature) throw new Error(`the staged bundle's code signature is not valid: ${signature}`);
      return info as BuildInfo;
    },
    launch: (strategy) => fx.launch(job.bundles.target, strategy),
    healthy: () => fx.healthy(job.bundles.target),
    holdSignals: fx.holdSignals,
  };
};

/** Engine stages from which a failure means the new build itself was bad (staged, swapped or unhealthy). */
const BUILD_FAULT_STAGES = new Set(["build", "swap", "relaunch", "rollback", "rollback-relaunch", "healthy"]);

export type Outcome =
  /** The helper still runs: look again later. */
  | { readonly kind: "pending" }
  | { readonly kind: "updated" }
  /** The build is bad here: rolled back (or failed after the swap). Never offer it again. */
  | { readonly kind: "failed"; readonly skip: boolean; readonly reason: string }
  /** Nothing changed (bots stayed busy, another install held the lock): may be offered again. */
  | { readonly kind: "postponed"; readonly reason: string };

/**
 * What became of `job`, read by whichever app runs afterwards (the new one, or the old one
 * after a rollback). Conservative: a build is skipped for good only when the evidence says the
 * build itself failed; an install that could not even start is not held against it.
 */
export const classifyOutcome = (job: Pick<UpdateJob, "build" | "commit" | "createdAt">, result: InstallResult | null, runningBuild: number | null, helperAlive: boolean): Outcome => {
  if (helperAlive) return { kind: "pending" };
  const mine = result !== null && Date.parse(result.startedAt) >= job.createdAt - 1000;
  if (!mine) {
    if (runningBuild === job.build) return { kind: "updated" };
    return { kind: "failed", skip: false, reason: "the update helper did not run" };
  }
  const ours = result.build?.commit === job.commit;
  if (result.status === "ok") {
    return ours ? { kind: "updated" } : { kind: "failed", skip: false, reason: "an earlier, interrupted install was finished first; try again" };
  }
  if (result.status === "aborted") return { kind: "postponed", reason: result.error ?? "the update did not start" };
  if (result.status === "running") {
    // The helper died mid-way (killed, power loss).
    if (runningBuild === job.build) return { kind: "updated" };
    return { kind: "failed", skip: ours && BUILD_FAULT_STAGES.has(result.stage), reason: `the update stopped during "${result.stage}"` };
  }
  // failed / rolled-back
  if (!ours) return { kind: "failed", skip: false, reason: result.error ?? "an earlier, interrupted install was dealt with first; try again" };
  return { kind: "failed", skip: BUILD_FAULT_STAGES.has(result.stage), reason: result.error ?? `failed during "${result.stage}"` };
};
