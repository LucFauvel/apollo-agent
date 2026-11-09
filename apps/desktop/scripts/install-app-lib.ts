/**
 * Building blocks of install-app.ts: command line, schema guard, waiting, health parsing,
 * bundle moves, database snapshots, the pending-install marker, the lock and the result
 * file. Every filesystem and SQLite action goes through `FileOps` / `SqliteOps`, so tests
 * run them against temporary directories (and inject failures). The install itself, the
 * state machine that uses these, is install-app-engine.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /**
   * Publishes a complete file at `path` only if nothing is there; false if something is.
   * Atomic: the file is never visible empty or half written.
   */
  readonly publishExclusive: (path: string, text: string) => boolean;
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
  publishExclusive: (path, text) => {
    // Written whole under a private name, then hard-linked into place: link fails if the
    // name exists, and never shows a partial file.
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, text, { flag: "wx" });
    try {
      linkSync(tmp, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      rmSync(tmp, { force: true });
    }
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

// ---------------------------------------------------------------------------------------
// Launching the app

/**
 * The environment the app is launched with: what a Finder or Dock launch would give, and
 * nothing the installer inherited. `open` forwards its caller's environment to the app, and
 * the installer runs inside an Apollo session, whose environment has ELECTRON_RUN_AS_NODE=1
 * (from the server process): with it, Electron starts as plain Node and exits at once, so
 * every launch silently did nothing (`open` still exits 0). APOLLO_*, NODE_OPTIONS and the
 * like would redirect the app too. Allowlist, rather than strip what is known to be bad.
 */
const LAUNCH_ENV_ALLOWED = /^(HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z]+|__CF_USER_TEXT_ENCODING|SSH_AUTH_SOCK)$/;
export const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const launchEnv = (env: NodeJS.ProcessEnv): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => LAUNCH_ENV_ALLOWED.test(e[0]) && typeof e[1] === "string")),
  PATH: LAUNCHD_PATH,
});

/**
 * How to launch, in escalating order: LaunchServices (`open -a`), a new LaunchServices
 * instance (`open -n -a`, in case it still sees a dying one), then the bundle's executable
 * directly, bypassing LaunchServices.
 */
export type LaunchStrategy = "open" | "open-new" | "exec";
export const LAUNCH_STRATEGIES: ReadonlyArray<LaunchStrategy> = ["open", "open-new", "exec"];

/** One launch attempt, as recorded in the log and the result file. */
export interface LaunchAttempt {
  readonly strategy: LaunchStrategy;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Exit status (`open`), or null for a spawned executable that keeps running. */
  readonly status: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly error: string | null;
  readonly pid: number | null;
  /** Filled in afterwards: whether the app's processes appeared after this attempt. */
  readonly launched?: boolean;
}

export const describeAttempt = (a: LaunchAttempt): string =>
  [
    `${a.strategy}: ${a.command} ${a.args.join(" ")}`,
    a.status !== null ? `exit ${a.status}` : a.pid !== null ? `pid ${a.pid}` : null,
    a.signal ? `signal ${a.signal}` : null,
    a.error ? `error: ${a.error}` : null,
    // Even with exit 0: LaunchServices explains itself on stderr when it does not launch.
    a.stderr ? `stderr: ${a.stderr}` : null,
    a.launched === undefined ? null : a.launched ? "launched" : "nothing launched",
  ]
    .filter(Boolean)
    .join("; ");

/** Runs one launch attempt for real. `openBin` is a parameter so tests can use a fake `open`. */
export const launchApp = (
  app: string,
  strategy: LaunchStrategy,
  env: Record<string, string>,
  o: { readonly openBin?: string; readonly executable?: string } = {},
): LaunchAttempt => {
  if (strategy === "exec") {
    const command = o.executable ?? join(app, "Contents", "MacOS", bundleExecutable(app));
    try {
      const child = spawn(command, [], { detached: true, stdio: "ignore", env, cwd: "/" });
      // An exec failure (ENOENT, EACCES) arrives as an event; it is recorded by the caller's
      // launch check (no process appears), and must not crash the installer.
      child.on("error", () => {});
      child.unref();
      return { strategy, command, args: [], status: null, signal: null, stderr: "", error: null, pid: child.pid ?? null };
    } catch (error) {
      return { strategy, command, args: [], status: null, signal: null, stderr: "", error: error instanceof Error ? error.message : String(error), pid: null };
    }
  }
  const command = o.openBin ?? "/usr/bin/open";
  const args = strategy === "open-new" ? ["-n", "-a", app] : ["-a", app];
  const r = spawnSync(command, args, { encoding: "utf8", env, timeout: 30_000 });
  return {
    strategy,
    command,
    args,
    status: r.status,
    signal: r.signal ?? null,
    stderr: (r.stderr ?? "").trim(),
    error: r.error ? r.error.message : null,
    pid: null,
  };
};

/** How the installer launches Apollo: always with the clean environment, never the inherited one. */
export const launchInstalled = (
  app: string,
  strategy: LaunchStrategy,
  inherited: NodeJS.ProcessEnv = process.env,
  o: { readonly openBin?: string; readonly executable?: string } = {},
): LaunchAttempt => launchApp(app, strategy, launchEnv(inherited), o);

/** CFBundleExecutable from the bundle's Info.plist ("apollo" for Apollo). */
const bundleExecutable = (app: string): string => {
  const r = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", join(app, "Contents", "Info.plist")], { encoding: "utf8" });
  const name = r.status === 0 ? r.stdout.trim() : "";
  return name || basename(app, ".app").toLowerCase();
};

export type LaunchOutcome =
  | { readonly ok: true; readonly attempts: ReadonlyArray<LaunchAttempt> }
  | { readonly ok: false; readonly why: "never-launched" | "launched-unhealthy"; readonly attempts: ReadonlyArray<LaunchAttempt> };

/**
 * Launches the app until its server answers /health. Each attempt escalates to the next
 * strategy if no process of the app appeared within `launchWindowMs`. Once the app is
 * running, it gets `startupGraceMs` to answer; if it exits or does not answer by then, that
 * is "launched but unhealthy", returned at once: launching it again would not help.
 */
export const launchUntilHealthy = async (deps: {
  readonly launch: (strategy: LaunchStrategy) => LaunchAttempt;
  /** Whether the app's processes are running: null when that cannot be told. */
  readonly running: () => boolean | null;
  readonly healthy: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly timeoutMs: number;
  readonly launchWindowMs: number;
  readonly startupGraceMs: number;
  readonly strategies?: ReadonlyArray<LaunchStrategy>;
}): Promise<LaunchOutcome> => {
  const strategies = deps.strategies ?? LAUNCH_STRATEGIES;
  const deadline = deps.now() + deps.timeoutMs;
  const attempts: Array<LaunchAttempt> = [];
  for (let i = 0; deps.now() < deadline; i++) {
    const strategy = strategies[Math.min(i, strategies.length - 1)]!;
    let attempt: LaunchAttempt;
    try {
      attempt = deps.launch(strategy);
    } catch (error) {
      attempt = { strategy, command: "?", args: [], status: null, signal: null, stderr: "", error: error instanceof Error ? error.message : String(error), pid: null };
    }
    // Wait for a sign of life: the app's processes (looked for first: `open` returns once the
    // process exists, so even an app that dies quickly is seen), or an answer.
    let launched = false;
    const windowEnd = Math.min(deps.now() + deps.launchWindowMs, deadline);
    for (;;) {
      if (deps.running() === true) {
        launched = true;
        break;
      }
      if (await deps.healthy()) {
        attempts.push({ ...attempt, launched: true });
        deps.log(`  launch ${attempts.length}: ${describeAttempt(attempts.at(-1)!)}; /health answers`);
        return { ok: true, attempts };
      }
      if (deps.now() >= windowEnd) break;
      await deps.sleep(1000);
    }
    attempts.push({ ...attempt, launched });
    deps.log(`  launch ${attempts.length}: ${describeAttempt(attempts.at(-1)!)}`);
    if (!launched) continue;
    // It runs: give it time to start, but do not launch it again.
    const graceEnd = Math.min(deps.now() + deps.startupGraceMs, deadline);
    for (;;) {
      if (await deps.healthy()) return { ok: true, attempts };
      if (deps.running() === false) {
        deps.log("  The app exited before answering /health");
        return { ok: false, why: "launched-unhealthy", attempts };
      }
      if (deps.now() >= graceEnd) {
        deps.log(`  The app runs but did not answer /health within ${deps.startupGraceMs / 1000} s`);
        return { ok: false, why: "launched-unhealthy", attempts };
      }
      await deps.sleep(1000);
    }
  }
  deps.log(`  Nothing launched after ${attempts.length} attempt(s) (${[...new Set(attempts.map((a) => a.strategy))].join(", ")})`);
  return { ok: false, why: "never-launched", attempts };
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

/**
 * A snapshot is usable only if its file matches the recorded SHA-256 and SQLite reads it at
 * the recorded version. Never throws: a malformed or unreadable snapshot is just not usable.
 */
export const validateSnapshot = (dir: string, files: FileOps = realFileOps, sqlite: SqliteOps = realSqliteOps): SnapshotCheck => {
  try {
    return checkSnapshot(dir, files, sqlite);
  } catch (error) {
    return { ok: false, reason: `could not be checked: ${error instanceof Error ? error.message : String(error)}` };
  }
};

const checkSnapshot = (dir: string, files: FileOps, sqlite: SqliteOps): SnapshotCheck => {
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(files.readText(join(dir, "snapshot.json"))) as SnapshotManifest;
  } catch {
    return { ok: false, reason: "no readable snapshot.json" };
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    typeof manifest.file !== "string" ||
    manifest.file === "" ||
    manifest.file.includes("/") ||
    typeof manifest.dbVersion !== "number" ||
    typeof manifest.sha256 !== "object" ||
    manifest.sha256 === null
  ) {
    return { ok: false, reason: "snapshot.json is malformed (an older or damaged snapshot)" };
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

/** "alive": a running installer. "gone": dead, or the pid now belongs to something else. "unknown": could not tell. */
export type LockState = "alive" | "gone" | "unknown";

/**
 * Whether `pid` is a running install:app. Throws when it cannot tell (the process list cannot
 * be read): an unknown owner is treated as holding the lock, never as gone.
 */
export type IsInstaller = (pid: number) => boolean;

/**
 * The lock is a directory of numbered generations. Nothing in it is ever deleted or
 * overwritten, so a number, once used, can never be handed out again:
 * - `<n>.json` is published atomically (whole, and only if that name is free) by the owner of n;
 * - `<n>.released` is published when that owner is done (or withdraws).
 * The owner is the highest n, unless it is released or its process is gone. To take over,
 * a contender publishes highest+1: only one contender can, and then checks no higher number
 * exists (one with a stale view finds the owner above it, releases its own number, and
 * looks again). There is no cleanup: a few bytes per install.
 */
const GENERATION = /^(\d+)\.json$/;
const generationFile = (dir: string, n: number) => join(dir, `${n}.json`);
const releasedFile = (dir: string, n: number) => join(dir, `${n}.released`);
const generations = (dir: string, files: FileOps) =>
  files
    .list(dir)
    .flatMap((entry) => {
      const match = GENERATION.exec(entry);
      return match ? [Number(match[1])] : [];
    })
    .filter((n) => Number.isSafeInteger(n))
    .sort((a, b) => a - b);

const inspectGeneration = (dir: string, n: number, isInstaller: IsInstaller, files: FileOps): { readonly holder: LockHolder | null; readonly state: LockState } => {
  if (files.exists(releasedFile(dir, n))) return { holder: null, state: "gone" };
  let holder: LockHolder;
  try {
    holder = JSON.parse(files.readText(generationFile(dir, n))) as LockHolder;
    if (typeof holder?.pid !== "number") throw new Error("no pid");
  } catch {
    // Published whole and never removed: unreadable means damaged. Refuse rather than guess.
    return { holder: null, state: "unknown" };
  }
  try {
    return { holder, state: isInstaller(holder.pid) ? "alive" : "gone" };
  } catch {
    return { holder, state: "unknown" };
  }
};

/** The current owner, or null when the lock is free (or its owner is gone). */
export const lockHolder = (
  dir: string,
  isInstaller: IsInstaller,
  files: FileOps = realFileOps,
): { readonly holder: LockHolder | null; readonly state: "alive" | "unknown" } | null => {
  const top = generations(dir, files).at(-1);
  if (top === undefined) return null;
  const view = inspectGeneration(dir, top, isInstaller, files);
  return view.state === "gone" ? null : { holder: view.holder, state: view.state };
};

export type LockResult =
  | { readonly ok: true; readonly generation: number; readonly tookOver: LockHolder | null }
  | { readonly ok: false; readonly holder: LockHolder | null; readonly state: "alive" | "unknown" };

export const acquireLock = (dir: string, me: LockHolder, isInstaller: IsInstaller, files: FileOps = realFileOps): LockResult => {
  files.mkdir(dir);
  const text = `${JSON.stringify(me)}\n`;
  for (let attempt = 0; attempt < 10; attempt++) {
    const top = generations(dir, files).at(-1) ?? 0;
    let tookOver: LockHolder | null = null;
    if (top > 0) {
      const view = inspectGeneration(dir, top, isInstaller, files);
      if (view.state !== "gone") return { ok: false, holder: view.holder, state: view.state };
      tookOver = view.holder;
    }
    const mine = top + 1;
    if (!Number.isSafeInteger(mine)) throw new Error(`The lock in ${dir} has run out of numbers`);
    // Someone else published this number first: look again.
    if (!files.publishExclusive(generationFile(dir, mine), text)) continue;
    if (generations(dir, files).some((n) => n > mine)) {
      // Published below the current owner (a stale view): give the number up, for good.
      files.publishExclusive(releasedFile(dir, mine), text);
      continue;
    }
    return { ok: true, generation: mine, tookOver };
  }
  throw new Error(`Could not take the lock in ${dir}: too much contention`);
};

/** Marks our generation released. Nothing is deleted, so its number is never reused. */
export const releaseLock = (dir: string, generation: number, me: LockHolder, files: FileOps = realFileOps): void => {
  try {
    if ((JSON.parse(files.readText(generationFile(dir, generation))) as LockHolder).pid === me.pid) {
      files.publishExclusive(releasedFile(dir, generation), `${JSON.stringify(me)}\n`);
    }
  } catch {
    // not ours
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
  /** Every launch attempt of this run (strategy, command, exit status, stderr, whether it launched). */
  readonly launches: ReadonlyArray<LaunchAttempt>;
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
  readonly lock: ReturnType<typeof lockHolder>;
  /** null: the process list could not be read. */
  readonly running: ReadonlyArray<string> | null;
  readonly busy: ReadonlyArray<string>;
  readonly schema: SchemaCheck;
  readonly bundles: Bundles;
  readonly hasDb: boolean;
  readonly backupsDir: string;
}): Array<string> => {
  const { options: o, bundles: b } = s;
  if (s.lock?.state === "alive") return [`Refuse: another install:app (pid ${s.lock.holder?.pid}, started ${s.lock.holder?.startedAt}) is running`];
  if (s.lock) return [`Refuse: the install lock is held by pid ${s.lock.holder?.pid ?? "?"}, and whether it still runs cannot be told`];
  if (s.running === null) return ["Refuse: the process list cannot be read, so whether Apollo is running cannot be told; a real run changes nothing"];
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
