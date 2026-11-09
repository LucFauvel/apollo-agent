/**
 * Seeding and checking the "old database" for the release smoke test (smoke.ts). Pure enough to
 * unit-test against the real migrations: the test opens a seeded database with the server's own
 * `open()` and checks what smoke.ts checks after the packaged app ran.
 */
import { connect as netConnect } from "node:net";
import { win32 as winPath } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** What gets seeded, so it can be found again after the app migrated the database. */
export const SEED = {
  botId: "smoke-bot",
  mainSessionId: "smoke-main",
  workerSessionId: "smoke-worker",
  memoryId: "smoke-memory",
  skillId: "smoke-skill",
  marker: "release-smoke-seed",
} as const;

/** The oldest schema the seed rows below are written for: migration 1 (the first release). */
export const SEED_MIN_VERSION = 1;

/**
 * Creates `path` at schema `version` (migrations [0, version) applied, `user_version = version`),
 * the way a user who last ran that version has it, then writes a bot with a main and a worker
 * session, events, a memory (with its FTS index) and a skill using only the columns migration 1
 * created. Every later migration must carry these rows forward.
 */
export const seedOldDatabase = (path: string, migrations: ReadonlyArray<string>, version: number): void => {
  if (!Number.isInteger(version) || version < SEED_MIN_VERSION || version > migrations.length) {
    throw new Error(`seed version ${version} is outside 1..${migrations.length}`);
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
    for (let v = 0; v < version; v++) {
      db.exec("begin");
      db.exec(migrations[v]!);
      db.exec(`pragma user_version = ${v + 1}`);
      db.exec("commit");
    }
    const t = 1_762_560_000_000; // 2025-11-08, older than any real data the migrations meet
    db.exec("begin");
    db.prepare(
      `insert into bots (id, name, instructions, cwd, main_provider, main_model, worker_provider, worker_model,
         runtime_mode, auto_learn, main_session_id, created_at, updated_at)
       values (?, 'Smoke', ?, '/tmp', 'claude', null, 'claude', null, 'full-access', 0, ?, ?, ?)`,
    ).run(SEED.botId, SEED.marker, SEED.mainSessionId, t, t);
    const session = db.prepare(
      `insert into sessions (id, bot_id, role, parent_session_id, title, provider, model, cwd, status, resume_id,
         last_message, completed_turns, turns_since_reflection, created_at, updated_at)
       values (?, ?, ?, ?, ?, 'claude', null, '/tmp', 'idle', null, ?, 1, 0, ?, ?)`,
    );
    session.run(SEED.mainSessionId, SEED.botId, "main", null, "Smoke main", SEED.marker, t, t);
    session.run(SEED.workerSessionId, SEED.botId, "worker", SEED.mainSessionId, "Smoke worker", SEED.marker, t, t);
    const event = db.prepare("insert into session_events (session_id, seq, at, event) values (?, ?, ?, ?)");
    event.run(SEED.mainSessionId, 1, t, JSON.stringify({ _tag: "UserMessage", text: SEED.marker, author: "user" }));
    event.run(SEED.mainSessionId, 2, t + 1, JSON.stringify({ _tag: "AssistantMessage", itemId: "smoke-item", text: "ok" }));
    db.prepare(
      `insert into memories (id, bot_id, kind, content, tags, source_session_id, pinned, created_at)
       values (?, ?, 'fact', ?, 'smoke', null, 0, ?)`,
    ).run(SEED.memoryId, SEED.botId, `the ${SEED.marker} memory`, t);
    db.prepare(
      `insert into skills (id, bot_id, name, description, body, status, version, source_session_id, created_at, updated_at)
       values (?, ?, 'smoke-skill', 'Seeded by the release smoke test', ?, 'active', 1, null, ?, ?)`,
    ).run(SEED.skillId, SEED.botId, SEED.marker, t, t);
    db.exec("commit");
  } finally {
    db.close();
  }
};

const count = (db: DatabaseSync, sql: string, ...params: Array<string>): number =>
  Number((db.prepare(sql).get(...params) as { n: number | bigint }).n);

/** What is wrong with the database after the app ran on it; empty when it migrated and kept the seed. */
export const checkMigratedDatabase = (path: string, expectedVersion: number): Array<string> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const problems: Array<string> = [];
    const version = (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
    if (version !== expectedVersion) problems.push(`schema version ${version}, expected ${expectedVersion}`);
    const integrity = (db.prepare("pragma integrity_check").get() as { integrity_check: string }).integrity_check;
    if (integrity !== "ok") problems.push(`integrity_check: ${integrity}`);
    if (count(db, "select count(*) as n from bots where id = ? and instructions = ?", SEED.botId, SEED.marker) !== 1) problems.push("the seeded bot is gone");
    if (count(db, "select count(*) as n from sessions where bot_id = ?", SEED.botId) !== 2) problems.push("the seeded sessions are gone");
    if (count(db, "select count(*) as n from session_events where session_id = ?", SEED.mainSessionId) < 2) problems.push("the seeded session events are gone");
    if (count(db, "select count(*) as n from memories where id = ?", SEED.memoryId) !== 1) problems.push("the seeded memory is gone");
    if (count(db, "select count(*) as n from memories_fts where memories_fts match ?", `"${SEED.marker}"`) < 1) problems.push("the memory search index lost the seeded memory");
    if (count(db, "select count(*) as n from skills where id = ?", SEED.skillId) !== 1) problems.push("the seeded skill is gone");
    return problems;
  } finally {
    db.close();
  }
};

/**
 * The server's base URL from the app's output: the HTTP server logs "Listening on http://…:<port>"
 * once it is bound. Only loopback addresses count. Null until that line appears.
 */
export const serverUrlFromLog = (log: string): string | null => {
  const m = /Listening on (http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5})\b/.exec(log);
  return m ? m[1]! : null;
};

export interface SmokeDirs {
  readonly home: string;
  readonly dataDir: string;
  readonly userDataDir: string;
  readonly screenshot: string;
  readonly screenshotDelayMs: number;
}

/** Variables that would redirect or break the launched app (case-insensitive: Windows env keys are). */
const LEAKY = /^(ELECTRON_|APOLLO_|NODE_OPTIONS$|NODE_PATH$)/i;

/**
 * The launched app's environment. macOS: install:app's allowlist (`launchEnv`). Windows: the
 * runner's environment (Windows needs SystemRoot, PATH, TEMP…) without ELECTRON_*, APOLLO_* and
 * NODE_* redirections. Both then point HOME (and USERPROFILE on Windows), the data dir, the
 * Chromium profile and the screenshot into the throwaway directory.
 */
export const smokeEnv = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  launchEnv: (env: NodeJS.ProcessEnv) => Record<string, string>,
  dirs: SmokeDirs,
): Record<string, string> => {
  const base =
    platform === "win32"
      ? Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string" && !LEAKY.test(e[0])))
      : launchEnv(env);
  const out: Record<string, string> = { ...base };
  if (platform === "win32") {
    for (const k of Object.keys(out)) if (/^(HOME|USERPROFILE)$/i.test(k)) delete out[k];
    out.USERPROFILE = dirs.home;
  }
  return {
    ...out,
    HOME: dirs.home,
    APOLLO_DATA_DIR: dirs.dataDir,
    APOLLO_USER_DATA_DIR: dirs.userDataDir,
    APOLLO_SCREENSHOT: dirs.screenshot,
    APOLLO_SCREENSHOT_DELAY: String(dirs.screenshotDelayMs),
  };
};

// ---------------------------------------------------------------------------------------
// Leftover processes (review P2-2). "The port stopped answering /health" is not "the server
// is gone": an unhealthy server still listening, or a live process that never listened, must
// fail the smoke test. smoke.ts combines three signals after the app exits:
//  1. any process descended from the app (sampled while it ran: a detached child is re-parented
//     once the app exits, so the tree is recorded during the run);
//  2. any process whose command line runs from the app's directory (bundle or install dir);
//  3. anything still ACCEPTING TCP connections on the server's port, whatever it answers.

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

/** `ps -axo pid=,ppid=,command=` output. */
export const parsePs = (text: string): Array<Proc> =>
  text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }] : [];
  });

/** PowerShell `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json`. */
export const parseWinProcesses = (json: string): Array<Proc> => {
  const trimmed = json.trim();
  if (!trimmed) return [];
  const raw: unknown = JSON.parse(trimmed);
  const list = Array.isArray(raw) ? raw : [raw];
  return list.flatMap((p) => {
    const o = p as { ProcessId?: unknown; ParentProcessId?: unknown; ExecutablePath?: unknown; CommandLine?: unknown };
    if (typeof o.ProcessId !== "number") return [];
    const command = [o.ExecutablePath, o.CommandLine].filter((v): v is string => typeof v === "string" && v !== "").join(" ");
    return [{ pid: o.ProcessId, ppid: typeof o.ParentProcessId === "number" ? o.ParentProcessId : 0, command }];
  });
};

/** Every process below `root` in the parent tree (not `root` itself). */
export const descendantsOf = (procs: ReadonlyArray<Proc>, root: number): Set<number> => {
  const found = new Set<number>();
  let frontier = [root];
  while (frontier.length) {
    const next = procs.filter((p) => frontier.includes(p.ppid) && !found.has(p.pid) && p.pid !== root).map((p) => p.pid);
    for (const pid of next) found.add(pid);
    frontier = next;
  }
  return found;
};

/**
 * How a path appears in a command line, for matching: case-folded (APFS and NTFS are
 * case-insensitive), macOS /private/var → /var and /private/tmp → /tmp (Electron reports
 * resolved paths), Windows separators unified.
 */
export const normalizeForMatch = (platform: NodeJS.Platform, text: string): string => {
  const lower = text.toLowerCase();
  return platform === "win32" ? lower.replaceAll("/", "\\") : lower.replaceAll("/private/var/", "/var/").replaceAll("/private/tmp/", "/tmp/");
};

/** Processes running from inside `dirs` (an app bundle or install directory), except `exclude`. */
export const processesUnder = (
  procs: ReadonlyArray<Proc>,
  dirs: ReadonlyArray<string>,
  platform: NodeJS.Platform,
  exclude: ReadonlySet<number> = new Set(),
): Array<Proc> => {
  const sep = platform === "win32" ? "\\" : "/";
  const needles = [...new Set(dirs.map((d) => normalizeForMatch(platform, d).replace(/[\\/]+$/, "") + sep))];
  return procs.filter((p) => !exclude.has(p.pid) && needles.some((n) => normalizeForMatch(platform, p.command).includes(n)));
};

/** Whether anything accepts a TCP connection on host:port (an unhealthy server still does). */
export const portAccepts = (port: number, host = "127.0.0.1", timeoutMs = 1000): Promise<boolean> =>
  new Promise((resolveAccepts) => {
    const socket = netConnect({ port, host });
    const done = (accepts: boolean) => {
      socket.destroy();
      resolveAccepts(accepts);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

// ---------------------------------------------------------------------------------------
// Silent NSIS install (review P2-3). NSIS takes the destination as `/D=<path>`, last on the
// command line and unquoted (everything after `/D=` is the path, spaces included). So the
// installer is started DIRECTLY (CreateProcess, no cmd.exe: `&`, `^`, `%`, `|`… in a path are
// plain characters) with verbatim arguments, and argv[0] quoted by hand. A `"` or a control
// character can't be in a Windows path and is refused rather than escaped.

export interface Invocation {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly options: { readonly shell: false; readonly windowsVerbatimArguments: true; readonly argv0: string };
}

const UNSAFE_IN_PATH = /["\u0000-\u001f]/;

export const nsisInstallInvocation = (installer: string, dir: string): Invocation => {
  if (!winPath.isAbsolute(installer)) throw new Error(`installer path must be absolute: ${installer}`);
  if (!winPath.isAbsolute(dir)) throw new Error(`install directory must be absolute: ${dir}`);
  for (const [label, p] of [["installer path", installer], ["install directory", dir]] as const) {
    if (UNSAFE_IN_PATH.test(p)) throw new Error(`${label} contains a quote or control character: ${JSON.stringify(p)}`);
  }
  return { file: installer, args: ["/S", `/D=${dir}`], options: { shell: false, windowsVerbatimArguments: true, argv0: `"${installer}"` } };
};

/** Runs the silent install through `spawn` (injected for tests); never through a shell. */
export const runSilentInstall = <R>(
  spawn: (file: string, args: ReadonlyArray<string>, options: Invocation["options"] & { readonly timeout: number }) => R,
  installer: string,
  dir: string,
): R => {
  const { file, args, options } = nsisInstallInvocation(installer, dir);
  return spawn(file, args, { ...options, timeout: 300_000 });
};
