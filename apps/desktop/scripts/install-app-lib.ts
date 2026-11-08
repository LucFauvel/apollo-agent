/**
 * The decisions behind install-app.ts, kept free of real side effects so they can be
 * tested: every filesystem, process and network action goes through the deps passed in.
 * install-app.ts wires these to the real /Applications, `open`, `ps` and the app's /health.
 */
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------------------
// Command line

export interface Options {
  /** Re-run detached from the calling session, logging to a file. */
  readonly detach: boolean;
  /** Skip waiting for running turns (they are stopped). */
  readonly now: boolean;
  /** Give up (leaving the app untouched) when bots are still busy after this long. */
  readonly waitTimeoutMs: number;
  /** Install even when the app's database is newer than the code being installed. */
  readonly force: boolean;
  /** Print the plan and touch nothing. */
  readonly dryRun: boolean;
  /** Don't open Apollo afterwards (and so keep the previous bundle: health is unknown). */
  readonly noOpen: boolean;
  /** Internal: this process is the detached child (the log already goes to a file). */
  readonly detachedChild: boolean;
}

export const DEFAULT_WAIT_TIMEOUT_MINUTES = 120;

export const parseArgs = (argv: ReadonlyArray<string>): Options => {
  let waitTimeoutMinutes = DEFAULT_WAIT_TIMEOUT_MINUTES;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--wait-timeout" || arg.startsWith("--wait-timeout=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      const minutes = Number(value);
      if (value === undefined || value === "" || !Number.isFinite(minutes) || minutes <= 0) {
        throw new Error(`--wait-timeout takes a positive number of minutes (got ${value ?? "nothing"})`);
      }
      waitTimeoutMinutes = minutes;
    } else if (["--detach", "--now", "--force", "--dry-run", "--no-open", "--detached-child"].includes(arg)) {
      flags.add(arg);
    } else {
      throw new Error(`Unknown option ${arg}`);
    }
  }
  return {
    detach: flags.has("--detach"),
    now: flags.has("--now"),
    waitTimeoutMs: waitTimeoutMinutes * 60_000,
    force: flags.has("--force"),
    dryRun: flags.has("--dry-run"),
    noOpen: flags.has("--no-open"),
    detachedChild: flags.has("--detached-child"),
  };
};

/** Arguments for the detached child: the same options, minus --detach. */
export const childArgs = (argv: ReadonlyArray<string>): Array<string> => [
  ...argv.filter((a) => a !== "--detach" && a !== "--detached-child"),
  "--detached-child",
];

// ---------------------------------------------------------------------------------------
// Database guard

/** The schema version of an Apollo database (`pragma user_version`), or null without one. */
export const readDbVersion = (path: string): number | null => {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("pragma busy_timeout = 3000");
    return (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
};

export type SchemaCheck = { readonly ok: true; readonly note: string } | { readonly ok: false; readonly message: string };

/**
 * Old code against a newer database breaks silently (unknown columns, missing tables),
 * so a downgrade is refused unless forced. A newer build just migrates on start.
 */
export const checkSchema = (dbVersion: number | null, codeVersion: number, force: boolean): SchemaCheck => {
  if (dbVersion === null) return { ok: true, note: "no database yet" };
  if (dbVersion <= codeVersion) {
    return { ok: true, note: dbVersion === codeVersion ? `schema ${dbVersion}, up to date` : `schema ${dbVersion} → ${codeVersion} on start` };
  }
  const message =
    `The database is at schema version ${dbVersion}, but this build only knows ${codeVersion} migration(s): ` +
    `it was opened by newer code (a branch with migrations this one lacks). ` +
    `Installing would run old code against a newer schema.`;
  return force ? { ok: true, note: `${message} Installing anyway (--force).` } : { ok: false, message: `${message} Use --force to install anyway.` };
};

// ---------------------------------------------------------------------------------------
// Waiting for running turns

export type IdleResult = { readonly idle: true } | { readonly idle: false; readonly busy: ReadonlyArray<string> };

export const waitForIdle = async (deps: {
  readonly busy: () => ReadonlyArray<string>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly timeoutMs: number;
  readonly pollMs?: number;
}): Promise<IdleResult> => {
  const deadline = deps.now() + deps.timeoutMs;
  let last = "";
  for (;;) {
    const busy = deps.busy();
    if (busy.length === 0) return { idle: true };
    if (deps.now() >= deadline) return { idle: false, busy };
    const summary = busy.join("; ");
    if (summary !== last) deps.log(`  Waiting for ${busy.length} turn(s) to finish: ${summary}`);
    last = summary;
    await deps.sleep(deps.pollMs ?? 5000);
  }
};

// ---------------------------------------------------------------------------------------
// Health of the running app

/** `APOLLO_PORT` from `ps eww -o command= -p <pid>` (the process and its environment). */
export const portFromPsEnv = (psOutput: string): number | null => {
  const match = /(?:^|\s)APOLLO_PORT=(\d+)(?:\s|$)/.exec(psOutput);
  const port = match ? Number(match[1]) : NaN;
  return port > 0 && port < 65536 ? port : null;
};

/** Loopback TCP ports from `lsof -a -p <pid> -iTCP -sTCP:LISTEN -P -n`. */
export const portsFromLsof = (lsofOutput: string): Array<number> => {
  const ports: Array<number> = [];
  for (const line of lsofOutput.split("\n")) {
    const match = /\s(?:127\.0\.0\.1|localhost|\[::1\]):(\d+) \(LISTEN\)/.exec(line);
    if (match && !ports.includes(Number(match[1]))) ports.push(Number(match[1]));
  }
  return ports;
};

/** Apollo's /health answers 200 with `{"ok":true}`; anything else is not Apollo, or not ready. */
export const isHealthyResponse = (status: number, body: string): boolean => {
  if (status !== 200) return false;
  try {
    return (JSON.parse(body) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
};

/** Delays between `open` attempts: quick at first, then every few seconds. */
export const backoff = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

/**
 * Opens the app until its server answers /health, or the deadline passes. `open` again
 * after a force-quit can be a no-op while LaunchServices still sees the dying instance,
 * so one `open` is not enough: retry it until the app is really up.
 */
export const relaunchUntilHealthy = async (deps: {
  readonly open: () => void;
  readonly healthy: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly timeoutMs: number;
}): Promise<boolean> => {
  const deadline = deps.now() + deps.timeoutMs;
  for (let attempt = 0; ; attempt++) {
    deps.log(`  open (attempt ${attempt + 1})`);
    deps.open();
    // Several health checks per attempt: launching takes a few seconds by itself.
    const nextOpen = Math.min(deps.now() + backoff(attempt) + 4000, deadline);
    do {
      if (await deps.healthy()) return true;
      await deps.sleep(1000);
    } while (deps.now() < nextOpen);
    if (deps.now() >= deadline) return deps.healthy();
  }
};

// ---------------------------------------------------------------------------------------
// Bundles: swap, roll back, recover

export interface Bundles {
  readonly target: string;
  readonly staged: string;
  readonly previous: string;
  /** Where a build that never became healthy is kept, to look at. */
  readonly failed: string;
}

export const BUNDLES: Bundles = {
  target: "/Applications/Apollo.app",
  staged: "/Applications/.Apollo-update.app",
  previous: "/Applications/.Apollo-previous.app",
  failed: "/Applications/.Apollo-failed.app",
};

export interface BundleFs {
  readonly exists: (path: string) => boolean;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
}

/** New bundle in place; the old one kept as `previous` until the new one is healthy. */
export const swap = (fs: BundleFs, b: Bundles): void => {
  if (!fs.exists(b.staged)) throw new Error(`Nothing staged at ${b.staged}`);
  fs.remove(b.previous);
  if (fs.exists(b.target)) fs.rename(b.target, b.previous);
  fs.rename(b.staged, b.target);
};

/** Put `previous` back in place; the bad bundle is kept as `failed`. Returns false without a previous bundle. */
export const restorePrevious = (fs: BundleFs, b: Bundles): boolean => {
  if (!fs.exists(b.previous)) return false;
  fs.remove(b.failed);
  if (fs.exists(b.target)) fs.rename(b.target, b.failed);
  fs.rename(b.previous, b.target);
  return true;
};

/**
 * An interrupted install can leave no app at all (between the two renames of a swap, or
 * of a rollback). Then the previous bundle goes back first. Returns whether it did.
 */
export const recoverIfNeeded = (fs: BundleFs, b: Bundles): boolean => {
  if (fs.exists(b.target) || !fs.exists(b.previous)) return false;
  fs.rename(b.previous, b.target);
  return true;
};

export type InstallOutcome =
  | { readonly status: "ok"; readonly stage: "healthy" | "installed-not-opened" }
  | { readonly status: "rolled-back"; readonly stage: "rollback-healthy"; readonly error: string }
  | { readonly status: "failed"; readonly stage: "rollback-unhealthy" | "no-previous"; readonly error: string };

/**
 * Swap → relaunch until healthy → drop the previous bundle. If the new app never gets
 * healthy, stop it, put the previous bundle back and relaunch that instead.
 */
export const swapAndVerify = async (deps: {
  readonly fs: BundleFs;
  readonly bundles: Bundles;
  readonly relaunch: () => Promise<boolean>;
  /** Stop whatever is running from the target bundle (the unhealthy new app). */
  readonly stopApp: () => Promise<void>;
  /** Copy the database aside; runs with Apollo stopped, before anything moves. */
  readonly snapshotData: () => void;
  /** Put that copy back: the new build may have migrated the database before failing. */
  readonly restoreData: () => void;
  readonly log: (line: string) => void;
  readonly open: boolean;
}): Promise<InstallOutcome> => {
  const { fs, bundles: b } = deps;
  deps.snapshotData();
  swap(fs, b);
  deps.log(`  ${b.target} is the new build; the previous one is kept at ${b.previous}`);
  if (!deps.open) return { status: "ok", stage: "installed-not-opened" };

  if (await deps.relaunch()) {
    fs.remove(b.previous);
    return { status: "ok", stage: "healthy" };
  }
  const error = "The new build did not answer /health in time";
  deps.log(`  ${error}: rolling back`);
  await deps.stopApp();
  if (!restorePrevious(fs, b)) return { status: "failed", stage: "no-previous", error: `${error}, and there is no previous build to restore` };
  deps.restoreData();
  if (await deps.relaunch()) return { status: "rolled-back", stage: "rollback-healthy", error };
  return { status: "failed", stage: "rollback-unhealthy", error: `${error}; the previous build was restored but is not healthy either` };
};

// ---------------------------------------------------------------------------------------
// Database snapshots

/** The database and its write-ahead log files. After a clean quit only the first exists. */
const DB_FILES = ["", "-wal", "-shm"] as const;
const SNAPSHOT_PREFIX = "pre-update-";
export const SNAPSHOTS_KEPT = 2;

export interface Snapshot {
  readonly dir: string;
  readonly createdAt: number;
  /** `pragma user_version` of the database when it was copied. */
  readonly dbVersion: number | null;
}

/**
 * Copies the database (with any -wal/-shm) to `<backupsDir>/pre-update-<epoch>-<label>/`.
 * Apollo must be stopped. APFS clones make the copy instant whatever the size.
 */
export const snapshotDb = (o: { readonly dbPath: string; readonly backupsDir: string; readonly label: string; readonly now: number }): Snapshot | null => {
  if (!existsSync(o.dbPath)) return null;
  const dir = join(o.backupsDir, `${SNAPSHOT_PREFIX}${o.now}-${o.label.replace(/[^\w.-]+/g, "_")}`);
  mkdirSync(dir, { recursive: true });
  const name = o.dbPath.split("/").at(-1)!;
  for (const suffix of DB_FILES) {
    if (existsSync(o.dbPath + suffix)) copyFileSync(o.dbPath + suffix, join(dir, name + suffix), constants.COPYFILE_FICLONE);
  }
  const snapshot: Snapshot = { dir, createdAt: o.now, dbVersion: readDbVersion(join(dir, name)) };
  writeFileSync(join(dir, "snapshot.json"), `${JSON.stringify({ ...snapshot, source: o.dbPath, label: o.label }, null, 2)}\n`);
  return snapshot;
};

/** Snapshots in `backupsDir`, newest first. */
export const listSnapshots = (backupsDir: string): Array<Snapshot> => {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .flatMap((entry): Array<Snapshot> => {
      const match = new RegExp(`^${SNAPSHOT_PREFIX}(\\d+)-`).exec(entry);
      if (!match) return [];
      const dir = join(backupsDir, entry);
      let dbVersion: number | null = null;
      try {
        dbVersion = (JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8")) as Snapshot).dbVersion;
      } catch {
        // an incomplete snapshot: listed (so it gets pruned), never restored
        return [{ dir, createdAt: Number(match[1]), dbVersion: null }];
      }
      return [{ dir, createdAt: Number(match[1]), dbVersion }];
    })
    .sort((a, b) => b.createdAt - a.createdAt);
};

/** Keeps the newest `keep` snapshots (always including `protect`), deletes the rest. */
export const pruneSnapshots = (backupsDir: string, keep: number, protect: string | null): Array<string> => {
  const all = listSnapshots(backupsDir);
  const newestFirst = [...new Set([...(protect ? [protect] : []), ...all.map((s) => s.dir)])];
  const kept = new Set(newestFirst.slice(0, Math.max(keep, protect ? 1 : 0)));
  const removed = all.filter((s) => !kept.has(s.dir)).map((s) => s.dir);
  for (const dir of removed) rmSync(dir, { recursive: true, force: true });
  return removed;
};

/**
 * Puts a snapshot back in place of the database. Apollo must be stopped. The current files
 * (including a -wal that belongs to them and would corrupt the restored copy) are moved
 * into the snapshot directory first, so nothing is lost.
 */
export const restoreDbSnapshot = (o: { readonly snapshotDir: string; readonly dbPath: string; readonly now: number }): string => {
  const name = o.dbPath.split("/").at(-1)!;
  if (!existsSync(join(o.snapshotDir, name))) throw new Error(`No database in ${o.snapshotDir}`);
  // Copy next to the database first: if that fails, nothing has changed yet.
  const copies = DB_FILES.filter((suffix) => existsSync(join(o.snapshotDir, name + suffix)));
  for (const suffix of copies) copyFileSync(join(o.snapshotDir, name + suffix), `${o.dbPath}${suffix}.restoring`, constants.COPYFILE_FICLONE);
  const aside = join(o.snapshotDir, `replaced-${o.now}`);
  mkdirSync(aside, { recursive: true });
  for (const suffix of DB_FILES) {
    if (existsSync(o.dbPath + suffix)) renameSync(o.dbPath + suffix, join(aside, name + suffix));
  }
  // Renames only from here: the old files are out of the way and never mixed with the copy.
  for (const suffix of ["-shm", "-wal", ""].filter((s) => copies.includes(s as (typeof DB_FILES)[number]))) {
    renameSync(`${o.dbPath}${suffix}.restoring`, o.dbPath + suffix);
  }
  return aside;
};

/**
 * After recovery put an older bundle back: should the database go back too? Only when the
 * database is newer than that bundle's code, and a snapshot exists that it can read.
 */
export const recoveryDbAction = (
  dbVersion: number | null,
  bundleSchema: number,
  latest: Snapshot | null,
): { readonly action: "none" } | { readonly action: "restore"; readonly snapshot: Snapshot } | { readonly action: "stuck"; readonly message: string } => {
  if (checkSchema(dbVersion, bundleSchema, false).ok) return { action: "none" };
  if (latest && latest.dbVersion !== null && checkSchema(latest.dbVersion, bundleSchema, false).ok) return { action: "restore", snapshot: latest };
  return {
    action: "stuck",
    message: `The database (schema ${dbVersion}) is newer than the restored app (schema ${bundleSchema}) and no snapshot it can read exists`,
  };
};

// ---------------------------------------------------------------------------------------
// Result file

export type ResultStatus = "running" | "ok" | "failed" | "aborted" | "rolled-back";

export interface BuildInfo {
  readonly commit: string;
  readonly dirty: boolean;
  readonly branch: string | null;
  readonly schemaVersion: number;
  readonly builtAt: string;
}

export interface InstallResult {
  readonly status: ResultStatus;
  /** The last stage reached, e.g. "build", "wait-idle", "quit", "swap", "healthy". */
  readonly stage: string;
  readonly build: BuildInfo | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly log: string | null;
  /** The database copy taken before the swap (restored on rollback). */
  readonly snapshot: string | null;
  readonly pid: number;
}

/** Written whole, then renamed into place: a reader never sees half a file. */
export const writeResult = (path: string, result: InstallResult): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(tmp, path);
};

// ---------------------------------------------------------------------------------------
// Dry run

/** What a real run would do, in order, given what is true right now. */
export const plan = (s: {
  readonly options: Options;
  readonly targetExists: boolean;
  readonly previousExists: boolean;
  readonly running: ReadonlyArray<string>;
  readonly busy: ReadonlyArray<string>;
  readonly schema: SchemaCheck;
  readonly bundles: Bundles;
  readonly hasDb: boolean;
  readonly backupsDir: string;
}): Array<string> => {
  const { options: o, bundles: b } = s;
  if (!s.targetExists && s.previousExists) {
    return [
      `Recovery: ${b.target} is missing; move ${b.previous} → ${b.target}, restore the latest database snapshot if the database is newer than that app, open it, and stop.`,
    ];
  }
  if (!s.schema.ok) return [`Refuse: ${s.schema.message}`];
  const steps = [`Database: ${s.schema.note}`, "Build web UI, shell, server bundle and tailnet addon; write build-info.json", "Package with electron-builder (--dir)", `Stage it at ${b.staged}`];
  if (s.running.length === 0) steps.push("Apollo is not running: nothing to wait for or quit");
  else {
    if (o.now) steps.push(`--now: don't wait (busy now: ${s.busy.length === 0 ? "none" : s.busy.join("; ")})`);
    else
      steps.push(
        s.busy.length === 0
          ? "No bot is mid-turn: go ahead"
          : `Wait up to ${o.waitTimeoutMs / 60_000} min for: ${s.busy.join("; ")}; then abort and leave the app untouched`,
      );
    steps.push(`Quit Apollo (${s.running.join(", ")}), ignoring SIGTERM/SIGHUP from here; force-stop after 30 s`);
  }
  steps.push(
    s.hasDb ? `Snapshot the database to ${s.backupsDir}/pre-update-…, keeping the last ${SNAPSHOTS_KEPT}` : "No database yet: no snapshot",
    `Swap: ${b.target} → ${b.previous}, ${b.staged} → ${b.target}`,
  );
  if (o.noOpen) steps.push(`--no-open: don't open; keep ${b.previous}`);
  else
    steps.push(
      "Open until /health answers (up to 2 min)",
      `Healthy: delete ${b.previous}`,
      `Not healthy: stop it, ${b.target} → ${b.failed}, ${b.previous} → ${b.target}, ${s.hasDb ? "restore the database snapshot, " : ""}open that until healthy`,
    );
  return steps;
};
