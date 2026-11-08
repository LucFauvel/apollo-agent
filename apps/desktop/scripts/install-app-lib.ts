/**
 * Building blocks of install-app.ts: command line, schema guard, waiting, health parsing,
 * bundle moves, database snapshots, the pending-install marker, the lock and the result
 * file. Every filesystem and SQLite action goes through `FileOps` / `SqliteOps`, so tests
 * run them against temporary directories (and inject failures). The install itself, the
 * state machine that uses these, is install-app-engine.ts.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  /** Print the plan and write nothing at all. */
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
// Files and SQLite, injectable

export interface FileOps {
  readonly exists: (path: string) => boolean;
  /** Atomic within a volume; replaces a file at `to`. */
  readonly rename: (from: string, to: string) => void;
  /** rm -rf; nothing if missing. */
  readonly remove: (path: string) => void;
  /** Copies one file (an APFS clone where possible). */
  readonly copy: (from: string, to: string) => void;
  readonly mkdir: (path: string) => void;
  readonly list: (dir: string) => Array<string>;
  readonly readText: (path: string) => string;
  readonly writeText: (path: string, text: string) => void;
  /** Creates the file only if it does not exist; false if it does. */
  readonly createExclusive: (path: string, text: string) => boolean;
  readonly sha256: (path: string) => string;
}

export const realFileOps: FileOps = {
  exists: existsSync,
  rename: renameSync,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  // FICLONE, not FICLONE_FORCE: a plain copy where cloning is not supported.
  copy: (from, to) => copyFileSync(from, to, constants.COPYFILE_FICLONE),
  mkdir: (path) => void mkdirSync(path, { recursive: true }),
  list: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, text) => {
    // Whole file or nothing: written aside, then renamed over.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  },
  createExclusive: (path, text) => {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    return true;
  },
  sha256: (path) => createHash("sha256").update(readFileSync(path)).digest("hex"),
};

/** What a database file is: its schema version, and whether SQLite finds it sound. */
export type DbState = { readonly version: number; readonly ok: boolean } | null;

export interface SqliteOps {
  /** null when the file is missing; ok=false when it cannot be opened or fails quick_check. */
  readonly inspect: (path: string) => DbState;
  /** Folds a copied database's -wal into the file and leaves it in rollback-journal mode: one self-contained file. */
  readonly toSingleFile: (path: string) => void;
}

export const realSqliteOps: SqliteOps = {
  inspect: (path) => {
    if (!existsSync(path)) return null;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("pragma busy_timeout = 3000");
      const version = (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
      const check = db.prepare("pragma quick_check").all() as Array<Record<string, unknown>>;
      const ok = check.length === 1 && Object.values(check[0]!)[0] === "ok";
      return { version, ok };
    } catch {
      return { version: -1, ok: false };
    } finally {
      db?.close();
    }
  },
  toSingleFile: (path) => {
    const db = new DatabaseSync(path);
    try {
      db.exec("pragma wal_checkpoint(truncate); pragma journal_mode = delete;");
    } finally {
      db.close();
    }
  },
};

// ---------------------------------------------------------------------------------------
// Database guard

/** Old code against a newer database breaks silently, so a downgrade is refused unless forced. */
export type SchemaCheck = { readonly ok: true; readonly note: string } | { readonly ok: false; readonly message: string };

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

/**
 * Every `APOLLO_PORT=<n>` token in `ps eww` output (arguments and environment run together,
 * so more than one can show up). Callers keep only ports the server really listens on.
 */
export const portsFromPsEnv = (psOutput: string): Array<number> => {
  const ports: Array<number> = [];
  for (const match of psOutput.matchAll(/(?<=^|\s)APOLLO_PORT=(\d+)(?=\s|$)/g)) {
    const port = Number(match[1]);
    if (port > 0 && port < 65536 && !ports.includes(port)) ports.push(port);
  }
  return ports;
};

export interface Listener {
  readonly host: string;
  readonly port: number;
}

/** Loopback TCP listeners from `lsof -a -p <pid> -iTCP -sTCP:LISTEN -P -n`, as URL hosts. */
export const listenersFromLsof = (lsofOutput: string): Array<Listener> => {
  const listeners: Array<Listener> = [];
  for (const line of lsofOutput.split("\n")) {
    const match = /\s(127\.0\.0\.1|localhost|\[::1\]):(\d+) \(LISTEN\)/.exec(line);
    if (!match) continue;
    const host = match[1] === "localhost" ? "127.0.0.1" : match[1]!;
    const port = Number(match[2]);
    if (!listeners.some((l) => l.host === host && l.port === port)) listeners.push({ host, port });
  }
  return listeners;
};

/** Where to ask a server pid for /health: its APOLLO_PORT if it listens there, else all its loopback ports. */
export const healthUrls = (psOutput: string, lsofOutput: string): Array<string> => {
  const listeners = listenersFromLsof(lsofOutput);
  const declared = portsFromPsEnv(psOutput);
  const chosen = declared.length > 0 ? listeners.filter((l) => declared.includes(l.port)) : listeners;
  return chosen.map((l) => `http://${l.host}:${l.port}/health`);
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

/** Healthy now and still healthy over `samples` more checks `intervalMs` apart: one answer is not enough. */
export const staysHealthy = async (deps: {
  readonly healthy: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly samples: number;
  readonly intervalMs: number;
}): Promise<boolean> => {
  for (let i = 0; i < deps.samples; i++) {
    await deps.sleep(deps.intervalMs);
    if (!(await deps.healthy())) return false;
  }
  return true;
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

export type BundleFs = Pick<FileOps, "exists" | "rename" | "remove">;

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

/** The database schema a bundle was built for (Contents/Resources/build-info.json), if it says. */
export const bundleSchema = (files: FileOps, bundle: string): number | null => {
  try {
    const info = JSON.parse(files.readText(join(bundle, "Contents", "Resources", "build-info.json"))) as Partial<BuildInfo>;
    return typeof info.schemaVersion === "number" ? info.schemaVersion : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------
// Database snapshots

const SNAPSHOT_PREFIX = "pre-update-";
export const SNAPSHOTS_KEPT = 2;

export interface Snapshot {
  readonly dir: string;
  readonly createdAt: number;
  /** `pragma user_version` of the copy, as recorded when it was taken (a hint: validate before use). */
  readonly dbVersion: number | null;
}

interface SnapshotManifest {
  readonly createdAt: number;
  readonly dbVersion: number;
  readonly file: string;
  readonly sha256: Readonly<Record<string, string>>;
  readonly source: string;
  readonly label: string;
}

/**
 * Copies the database to `<backupsDir>/pre-update-<epoch>-<label>/` as one self-contained
 * file (any -wal folded in), checks SQLite can read it, and records its version and SHA-256.
 * Apollo must be stopped. Returns null when there is no database yet.
 */
export const takeSnapshot = (
  o: { readonly dbPath: string; readonly backupsDir: string; readonly label: string; readonly now: number },
  files: FileOps = realFileOps,
  sqlite: SqliteOps = realSqliteOps,
): Snapshot | null => {
  if (!files.exists(o.dbPath)) return null;
  const name = basename(o.dbPath);
  const dir = join(o.backupsDir, `${SNAPSHOT_PREFIX}${o.now}-${o.label.replace(/[^\w.-]+/g, "_")}`);
  files.mkdir(dir);
  const copy = join(dir, name);
  files.copy(o.dbPath, copy);
  // The -wal holds committed transactions not yet in the file; the -shm is rebuilt by SQLite.
  if (files.exists(`${o.dbPath}-wal`)) files.copy(`${o.dbPath}-wal`, `${copy}-wal`);
  sqlite.toSingleFile(copy);
  files.remove(`${copy}-wal`);
  files.remove(`${copy}-shm`);
  const state = sqlite.inspect(copy);
  if (!state?.ok) throw new Error(`The database copy in ${dir} is not readable; not updating without a usable snapshot`);
  const manifest: SnapshotManifest = { createdAt: o.now, dbVersion: state.version, file: name, sha256: { [name]: files.sha256(copy) }, source: o.dbPath, label: o.label };
  files.writeText(join(dir, "snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, createdAt: o.now, dbVersion: state.version };
};

/** Snapshots in `backupsDir`, newest first (including incomplete ones, so they get pruned). */
export const listSnapshots = (backupsDir: string, files: FileOps = realFileOps): Array<Snapshot> =>
  files
    .list(backupsDir)
    .flatMap((entry): Array<Snapshot> => {
      const match = new RegExp(`^${SNAPSHOT_PREFIX}(\\d+)-`).exec(entry);
      if (!match) return [];
      const dir = join(backupsDir, entry);
      let dbVersion: number | null = null;
      try {
        dbVersion = (JSON.parse(files.readText(join(dir, "snapshot.json"))) as SnapshotManifest).dbVersion;
      } catch {
        // incomplete
      }
      return [{ dir, createdAt: Number(match[1]), dbVersion }];
    })
    .sort((a, b) => b.createdAt - a.createdAt);

export type SnapshotCheck = { readonly ok: true; readonly version: number; readonly file: string } | { readonly ok: false; readonly reason: string };

/** A snapshot is usable only if its file matches the recorded SHA-256 and SQLite reads it at the recorded version. */
export const validateSnapshot = (dir: string, files: FileOps = realFileOps, sqlite: SqliteOps = realSqliteOps): SnapshotCheck => {
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(files.readText(join(dir, "snapshot.json"))) as SnapshotManifest;
  } catch {
    return { ok: false, reason: "no readable snapshot.json" };
  }
  const file = join(dir, manifest.file);
  if (!files.exists(file)) return { ok: false, reason: `${manifest.file} is missing` };
  const expected = manifest.sha256?.[manifest.file];
  if (!expected || files.sha256(file) !== expected) return { ok: false, reason: `${manifest.file} does not match its recorded SHA-256` };
  const state = sqlite.inspect(file);
  if (!state?.ok) return { ok: false, reason: `${manifest.file} is not a sound SQLite database` };
  if (state.version !== manifest.dbVersion) return { ok: false, reason: `schema ${state.version}, but recorded as ${manifest.dbVersion}` };
  return { ok: true, version: state.version, file };
};

/** Keeps the newest `keep` snapshots, and always those in `protect`; deletes the rest. */
export const pruneSnapshots = (backupsDir: string, keep: number, protect: ReadonlyArray<string>, files: FileOps = realFileOps): Array<string> => {
  const all = listSnapshots(backupsDir, files);
  const kept = new Set([...protect, ...all.map((s) => s.dir).slice(0, keep)]);
  const removed = all.filter((s) => !kept.has(s.dir)).map((s) => s.dir);
  for (const dir of removed) files.remove(dir);
  return removed;
};

/**
 * Puts a validated snapshot in place of the database, verify-then-commit:
 * 1. copy it next to the database and check the copy (hash, SQLite, version): nothing changed yet;
 * 2. copy the current database (and its -wal/-shm) aside, into the snapshot directory;
 * 3. `beforeCommit` (the caller records that a restore is under way, so an interruption is resumed);
 * 4. drop the current -wal/-shm (they belong to the current file and would corrupt the copy), then
 *    rename the copy over the database: there is always a database file in place;
 * 5. check the database in place.
 * Throws on any failure; from step 4 on, the copy aside and the snapshot are both intact.
 */
export const restoreSnapshot = (
  o: { readonly snapshotDir: string; readonly dbPath: string; readonly now: number; readonly beforeCommit: () => void },
  files: FileOps = realFileOps,
  sqlite: SqliteOps = realSqliteOps,
): { readonly aside: string; readonly version: number } => {
  const check = validateSnapshot(o.snapshotDir, files, sqlite);
  if (!check.ok) throw new Error(`Snapshot ${o.snapshotDir} is not usable: ${check.reason}`);
  const name = basename(o.dbPath);
  const staging = join(dirname(o.dbPath), `.restore-${o.now}`);
  files.mkdir(staging);
  const copy = join(staging, name);
  files.copy(check.file, copy);
  const recorded = (JSON.parse(files.readText(join(o.snapshotDir, "snapshot.json"))) as SnapshotManifest).sha256[basename(check.file)];
  if (files.sha256(copy) !== recorded) throw new Error(`The copy of ${check.file} does not match its SHA-256`);
  const copied = sqlite.inspect(copy);
  if (!copied?.ok || copied.version !== check.version) throw new Error(`The copy of ${check.file} is not readable at schema ${check.version}`);

  const aside = join(o.snapshotDir, `replaced-${o.now}`);
  files.mkdir(aside);
  for (const suffix of ["", "-wal", "-shm"]) {
    if (files.exists(o.dbPath + suffix)) files.copy(o.dbPath + suffix, join(aside, name + suffix));
  }

  o.beforeCommit();
  files.remove(`${o.dbPath}-wal`);
  files.remove(`${o.dbPath}-shm`);
  files.rename(copy, o.dbPath);
  const placed = sqlite.inspect(o.dbPath);
  if (!placed?.ok || placed.version !== check.version) throw new Error(`The restored database at ${o.dbPath} does not read back at schema ${check.version}`);
  files.remove(staging);
  return { aside, version: check.version };
};

// ---------------------------------------------------------------------------------------
// Pending-install marker

/**
 * Written before the first change to the installed app, removed once the bundle and the
 * database agree again. While it exists, the next run finishes or undoes that install first.
 */
export interface Marker {
  /** swapping: Apollo is stopped, snapshot/swap under way. verifying: the new build is in place, not yet healthy.
   *  rolling-back: going back to the previous build. restoring-db: the database is being replaced. */
  readonly phase: "swapping" | "verifying" | "rolling-back" | "restoring-db";
  readonly startedAt: string;
  readonly pid: number;
  readonly snapshot: string | null;
  /** The schema the previous build reads (its build-info, or the snapshot taken with it). */
  readonly previousSchema: number | null;
}

export const readMarker = (path: string, files: FileOps = realFileOps): Marker | null => {
  if (!files.exists(path)) return null;
  try {
    return JSON.parse(files.readText(path)) as Marker;
  } catch {
    // Unreadable: still an install that did not finish. Assume the least.
    return { phase: "rolling-back", startedAt: "unknown", pid: 0, snapshot: null, previousSchema: null };
  }
};

// ---------------------------------------------------------------------------------------
// Lock: one install at a time

export interface LockHolder {
  readonly pid: number;
  readonly startedAt: string;
}

export const lockHolder = (path: string, isInstaller: (pid: number) => boolean, files: FileOps = realFileOps): LockHolder | null => {
  if (!files.exists(path)) return null;
  try {
    const holder = JSON.parse(files.readText(path)) as LockHolder;
    return typeof holder.pid === "number" && isInstaller(holder.pid) ? holder : null;
  } catch {
    return null;
  }
};

/**
 * Takes the lock, or says who has it. A lock whose process is gone (or is no longer an
 * installer: pids get reused) is stale and taken over.
 */
export const acquireLock = (
  path: string,
  me: LockHolder,
  isInstaller: (pid: number) => boolean,
  files: FileOps = realFileOps,
): { readonly ok: true; readonly tookOver: LockHolder | null } | { readonly ok: false; readonly holder: LockHolder } => {
  files.mkdir(dirname(path));
  const text = `${JSON.stringify(me)}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (files.createExclusive(path, text)) return { ok: true, tookOver: null };
    const holder = lockHolder(path, isInstaller, files);
    if (holder && holder.pid !== me.pid) return { ok: false, holder };
    let stale: LockHolder | null = null;
    try {
      stale = JSON.parse(files.readText(path)) as LockHolder;
    } catch {
      // unreadable: stale
    }
    files.remove(path);
    if (files.createExclusive(path, text)) return { ok: true, tookOver: stale };
  }
  throw new Error(`Could not take the lock ${path}`);
};

export const releaseLock = (path: string, me: LockHolder, files: FileOps = realFileOps): void => {
  try {
    if ((JSON.parse(files.readText(path)) as LockHolder).pid === me.pid) files.remove(path);
  } catch {
    // not ours, or gone
  }
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
  /** What to do by hand, when the installer stopped without a working Apollo. */
  readonly manual: string | null;
  readonly log: string | null;
  readonly pid: number;
  /** The database copy taken before the swap (restored on rollback). */
  readonly snapshot: string | null;
}

/** Written whole, then renamed into place: a reader never sees half a file. */
export const writeResult = (path: string, result: InstallResult, files: FileOps = realFileOps): void => {
  files.mkdir(dirname(path));
  files.writeText(path, `${JSON.stringify(result, null, 2)}\n`);
};

// ---------------------------------------------------------------------------------------
// Dry run

/** What a real run would do, in order, given what is true right now. */
export const plan = (s: {
  readonly options: Options;
  readonly targetExists: boolean;
  readonly previousExists: boolean;
  readonly marker: Marker | null;
  readonly lock: LockHolder | null;
  readonly running: ReadonlyArray<string>;
  readonly busy: ReadonlyArray<string>;
  readonly schema: SchemaCheck;
  readonly bundles: Bundles;
  readonly hasDb: boolean;
  readonly backupsDir: string;
}): Array<string> => {
  const { options: o, bundles: b } = s;
  if (s.lock) return [`Refuse: another install:app (pid ${s.lock.pid}, started ${s.lock.startedAt}) is running`];
  if (s.marker || (!s.targetExists && s.previousExists)) {
    return [
      `Recovery: an install did not finish (${s.marker ? `phase ${s.marker.phase}` : `${b.target} is missing`}). ` +
        `Finish or undo it (bundle back from ${b.previous} if needed, database snapshot if the database is newer than that build), open it, and stop. ` +
        `Refuses while Apollo is running, unless it is already consistent and healthy.`,
    ];
  }
  if (!s.schema.ok) return [`Refuse: ${s.schema.message}`];
  const steps = [`Database: ${s.schema.note}`, "Build web UI, shell, server bundle and tailnet addon; write build-info.json", "Package with electron-builder (--dir)", `Stage it at ${b.staged}`];
  if (s.running.length === 0) steps.push("Apollo is not running: nothing to wait for");
  else if (o.now) steps.push(`--now: don't wait (busy now: ${s.busy.length === 0 ? "none" : s.busy.join("; ")})`);
  else
    steps.push(
      s.busy.length === 0 ? "No bot is mid-turn: go ahead" : `Wait up to ${o.waitTimeoutMs / 60_000} min for: ${s.busy.join("; ")}; then abort and leave the app untouched`,
    );
  steps.push(
    `Stop every Apollo process (${s.running.length === 0 ? "none running" : s.running.join(", ")}), ignoring SIGTERM/SIGHUP from here; force-stop stragglers; abort if any survives`,
    s.hasDb ? `Snapshot the database to ${s.backupsDir}/pre-update-… (one checked file + SHA-256), keeping the last ${SNAPSHOTS_KEPT}` : "No database yet: no snapshot",
    `Swap: ${b.target} → ${b.previous}, ${b.staged} → ${b.target}`,
  );
  if (o.noOpen) steps.push(`--no-open: don't open; keep ${b.previous}`);
  else
    steps.push(
      "Open until /health answers (up to 2 min), then stay healthy for 15 s",
      `Healthy: delete ${b.previous}`,
      `Not healthy (or any error from the stop on): stop it, ${b.target} → ${b.failed}, ${b.previous} → ${b.target}, ${s.hasDb ? "restore the database snapshot (checked before and after), " : ""}open that until healthy. ` +
        "If the database cannot be restored, nothing is opened and the result file says what to do.",
    );
  return steps;
};
