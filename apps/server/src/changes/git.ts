import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Git plumbing for change tracking. A snapshot is a tree object of the working tree
 * (tracked and untracked files, minus ignored ones), written through a temporary copy of
 * the index: the user's own index and checkout are never touched.
 */

const MAX_BUFFER = 64 * 1024 * 1024;

/** A failed git command, with its exit code (null when it was killed or did not start). */
export class GitError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  /** What it wrote before failing (some commands, like `merge-tree`, report in their exit code). */
  readonly stdout: string;
  constructor(message: string, code: number | null, stderr: string, stdout = "") {
    super(message);
    this.code = code;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

const GIT_TIMEOUT_MS = 60_000;
/** After git exits: how long to wait for its output to drain (a descendant may hold the pipe). */
export const EXIT_DRAIN_MS = 250;
/** After stopping git: how long it may take to go before the call fails anyway, naming its group. */
export const STOP_DEADLINE_MS = 2_000;

/**
 * Runs git. It leads its own process group, so stopping it (when `signal` aborts, after a
 * minute, or past the output limit) kills what it started too: clean/smudge filters, hooks,
 * credential helpers. The call always settles in bounded time: once git itself exits (output
 * a descendant still holds open is not waited for), or within STOP_DEADLINE_MS of stopping it
 * even if it cannot be confirmed gone; a kill that fails is reported, not ignored.
 */
const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv, signal?: AbortSignal, input?: string) =>
  new Promise<string>((resolvePromise, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const command = `git ${args[0] ?? ""}`;
    const child = spawn("git", [...args], {
      cwd,
      env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    if (input !== undefined) {
      child.stdin!.on("error", () => {}); // git exiting early is reported by its exit code
      child.stdin!.end(input);
    }
    const out: Array<Buffer> = [];
    const err: Array<Buffer> = [];
    let size = 0;
    let settled = false;
    let stopped: Error | null = null;
    const timers: Array<NodeJS.Timeout> = [];
    const later = (ms: number, fn: () => void) => void timers.push(setTimeout(fn, ms));

    const settle = (outcome: { readonly value: string } | { readonly error: Error }) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Nothing more is read: a pipe a descendant kept open must not keep this call alive.
      child.stdout!.destroy();
      child.stderr!.destroy();
      if ("value" in outcome) resolvePromise(outcome.value);
      else reject(outcome.error);
    };

    const stop = (reason: Error) => {
      if (stopped || settled) return;
      stopped = reason;
      const failure = killGroup(child);
      if (failure) {
        settle({ error: new GitError(`${reason.message}; and ${command} (process group ${child.pid}) could not be stopped: ${failure.message}`, null, "") });
        return;
      }
      later(STOP_DEADLINE_MS, () =>
        settle({ error: new GitError(`${reason.message}; and ${command} (process group ${child.pid}) was not confirmed stopped`, null, "") }),
      );
    };
    const onAbort = () => stop(abortError(signal!));
    later(GIT_TIMEOUT_MS, () => stop(new GitError(`${command} took over a minute and was stopped`, null, "")));
    signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (into: Array<Buffer>) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BUFFER) stop(new GitError(`${command} wrote more than ${MAX_BUFFER} bytes`, null, ""));
      else into.push(chunk);
    };
    child.stdout!.on("data", collect(out));
    child.stderr!.on("data", collect(err));

    const finish = (code: number | null) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (stopped) settle({ error: stopped });
      else if (code !== 0) settle({ error: new GitError(stderr || `${command} exited with ${code}`, code, stderr, stdout) });
      else settle({ value: stdout });
    };
    child.once("error", (error) => settle({ error: stopped ?? new GitError(error.message, null, "") }));
    // Normally the pipes close right after git exits; when something else holds them, settle anyway.
    child.once("exit", (code) => later(EXIT_DRAIN_MS, () => finish(code)));
    child.once("close", (code) => finish(code));
  });

const gitWithInput = (cwd: string, args: ReadonlyArray<string>, input: string, env?: NodeJS.ProcessEnv) => git(cwd, args, env, undefined, input);

/**
 * Kills a process and, outside Windows, every process in its group. Returns why it could
 * not (a group that is already gone is not a failure), or null.
 */
const killGroup = (child: ChildProcess): Error | null => {
  try {
    if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
    // Still try git itself, so at least the direct process goes.
    try {
      child.kill("SIGKILL");
    } catch {}
    return error as Error;
  }
};

const abortError = (signal: AbortSignal) => (signal.reason instanceof Error ? signal.reason : new Error("Stopped"));

/** The repository (worktree) a path is in, or null. */
export const repoRoot = async (path: string, signal?: AbortSignal): Promise<string | null> => {
  if (signal?.aborted) throw abortError(signal);
  let dir = resolve(path);
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    // A path that does not exist yet (a file about to be written): look from its folder.
    while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
  }
  try {
    return (await git(dir, ["rev-parse", "--show-toplevel"], undefined, signal)).trim() || null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
};

/** The repository's common git dir (shared by its worktrees), where snapshot trees are written. */
export const commonGitDir = async (repo: string, signal?: AbortSignal) =>
  (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], undefined, signal)).trim();

/** Tree operations run against the git dir, so they work after a worktree is removed. */
const inGitDir = (gitDir: string, args: ReadonlyArray<string>, signal?: AbortSignal) =>
  git(tmpdir(), ["--git-dir", gitDir, ...args], undefined, signal);

/** A tree object of the working tree as it is now. */
export const snapshot = async (repo: string, signal?: AbortSignal): Promise<string> => {
  const scratch = mkdtempSync(join(tmpdir(), "apollo-snapshot-"));
  const index = join(scratch, "index");
  try {
    // Starting from the real index keeps its stat cache: only changed files are hashed.
    const real = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"], undefined, signal)).trim();
    if (existsSync(real)) {
      // Keep the index's own time: git rehashes files changed in the same instant as the
      // index ("racily clean"), judged against it. A copy stamped now would hide an edit made
      // right after a commit that left the file's size unchanged. Content and time come from
      // one open file: git replaces the index by renaming a new one over it, so both describe
      // the same version even when it is replaced meanwhile.
      const fd = openSync(real, "r");
      try {
        const { atime, mtime } = fstatSync(fd);
        writeFileSync(index, readFileSync(fd));
        utimesSync(index, atime, mtime);
      } finally {
        closeSync(fd);
      }
    }
    const env = { GIT_INDEX_FILE: index };
    await git(repo, ["add", "-A", "--", "."], env, signal);
    return (await git(repo, ["write-tree"], env, signal)).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: FileStatus;
  /** null for binary files. */
  readonly additions: number | null;
  readonly deletions: number | null;
}

const STATUS: Record<string, FileStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "modified", C: "added" };

/** The files that differ between two snapshots, sorted by path. */
export const diffFiles = async (gitDir: string, before: string, after: string, signal?: AbortSignal): Promise<Array<FileChange>> => {
  if (before === after) return [];
  const [names, numbers] = await Promise.all([
    inGitDir(gitDir, ["diff", "--no-ext-diff", "-M", "--name-status", "-z", before, after], signal),
    inGitDir(gitDir, ["diff", "--no-ext-diff", "-M", "--numstat", "-z", before, after], signal),
  ]);
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  const n = numbers.split("\0");
  for (let i = 0; i < n.length; i++) {
    const entry = n[i];
    if (!entry) continue;
    const [add, del, path] = entry.split("\t");
    // Renames: "<add>\t<del>\t" then the old and new paths as two more fields.
    const target = path ? path : (i += 2, n[i]);
    if (target === undefined) continue;
    counts.set(target, { additions: add === "-" ? null : Number(add), deletions: del === "-" ? null : Number(del) });
  }
  const files: Array<FileChange> = [];
  const s = names.split("\0");
  for (let i = 0; i < s.length; ) {
    const code = s[i++];
    if (!code) continue;
    const status = STATUS[code[0]!] ?? "modified";
    const oldPath = status === "renamed" ? s[i++]! : null;
    const path = s[i++]!;
    const c = counts.get(path) ?? { additions: null, deletions: null };
    files.push({ path, oldPath, status, ...c });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
};

// --- what a turn changed itself, apart from what moving HEAD brought in ----------------

/** One path of a raw diff: mode and object on each side ("000000" and zeros when absent). */
interface RawEntry {
  readonly srcMode: string;
  readonly dstMode: string;
  readonly src: string;
  readonly dst: string;
}

/** The paths that differ between two trees, without rename detection. */
const rawDiff = async (gitDir: string, a: string, b: string, signal?: AbortSignal): Promise<Map<string, RawEntry>> => {
  const entries = new Map<string, RawEntry>();
  if (a === b) return entries;
  const out = await inGitDir(gitDir, ["diff", "--no-ext-diff", "--raw", "--no-renames", "--no-abbrev", "-z", a, b], signal);
  const s = out.split("\0");
  for (let i = 0; i + 1 < s.length; i += 2) {
    const meta = s[i]!;
    const path = s[i + 1]!;
    if (!meta.startsWith(":")) break;
    const [srcMode, dstMode, src, dst] = meta.slice(1).split(" ");
    entries.set(path, { srcMode: srcMode!, dstMode: dstMode!, src: src!, dst: dst! });
  }
  return entries;
};

/** Renames between two trees (git's own detection), by destination: the source path and its entry. */
const renamesBetween = async (gitDir: string, a: string, b: string) => {
  const out = await inGitDir(gitDir, ["diff", "--no-ext-diff", "--raw", "-M", "--no-abbrev", "-z", a, b]);
  const renames = new Map<string, { path: string; mode: string; object: string }>();
  const s = out.split("\0");
  for (let i = 0; i < s.length; ) {
    const meta = s[i++]!;
    if (!meta.startsWith(":")) break;
    const [srcMode, , src, , status] = meta.slice(1).split(" ");
    if (status?.startsWith("R") || status?.startsWith("C")) {
      const from = s[i++]!;
      const to = s[i++]!;
      if (status.startsWith("R")) renames.set(to, { path: from, mode: srcMode!, object: src! });
    } else i++;
  }
  return renames;
};

const sameChange = (x: RawEntry, y: RawEntry | undefined) =>
  y !== undefined && x.srcMode === y.srcMode && x.dstMode === y.dstMode && x.src === y.src && x.dst === y.dst;

/** When HEAD's oldest reflog entry was written (unix seconds), or null without a reflog. */
const firstReflogTime = async (repo: string) => {
  const out = await git(repo, ["reflog", "show", "--date=unix", "--format=%gd", "HEAD"]).catch(() => "");
  const match = /@\{(\d+)\}/.exec(out.trim().split("\n").at(-1) ?? "");
  return match ? Number(match[1]) : null;
};

/** A snapshot with the commit HEAD was at when it was taken (null without commits). */
export interface Snapshot {
  readonly tree: string;
  readonly head: string | null;
}

const treeOfIn = (gitDir: string, commit: string) => inGitDir(gitDir, ["rev-parse", `${commit}^{tree}`]).then((s) => s.trim());

/** More commits than this made in one turn (a large rebase): every path they touch is the turn's, unfiltered. */
const MAX_OWN_COMMITS = 200;

/**
 * The paths the turn's own commits changed themselves. A commit with one parent: what it
 * changed. A merge: what differs from the merge git makes on its own (`merge-tree`), so a
 * conflict resolved in any way (even by taking one side whole) or an edit made in the merge
 * is the turn's, and what one side brought in cleanly is not. When that cannot be told (a
 * root commit, an octopus, an older git), everything that differs from any parent is.
 */
/**
 * What a two-parent merge commit holds beyond the merge git makes on its own (`merge-tree`):
 * a conflict resolved (in any way, even by taking one side whole) or an edit. Empty for a
 * clean merge; null when that cannot be told (not two parents, merge-tree unavailable).
 */
const mergeOwnDelta = async (gitDir: string, parents: ReadonlyArray<string>, tree: string, signal?: AbortSignal) => {
  if (parents.length !== 2) return null;
  const merged = await inGitDir(gitDir, ["merge-tree", "--write-tree", "-z", "--no-messages", parents[0]!, parents[1]!], signal).catch((error) =>
    // Exit 1: conflicts, with the tree (conflict markers in it) written all the same.
    error instanceof GitError && error.code === 1 ? error.stdout : signal?.aborted ? Promise.reject(error) : null,
  );
  const auto = merged?.split("\0")[0]?.trim();
  return auto && /^[0-9a-f]{40,64}$/.test(auto) ? rawDiff(gitDir, auto, tree, signal) : null;
};

const ownPaths = async (gitDir: string, commits: ReadonlyArray<{ sha: string; parents: ReadonlyArray<string> }>) => {
  const paths = new Set<string>();
  const add = (diff: Map<string, RawEntry>) => {
    for (const path of diff.keys()) paths.add(path);
  };
  for (const { sha, parents } of commits) {
    const tree = await treeOfIn(gitDir, sha);
    if (parents.length === 0) {
      add(await rawDiff(gitDir, await inGitDir(gitDir, ["hash-object", "-t", "tree", "/dev/null"]).then((s) => s.trim()), tree));
      continue;
    }
    const delta = await mergeOwnDelta(gitDir, parents, tree);
    if (delta) {
      add(delta);
      continue;
    }
    for (const parent of parents) add(await rawDiff(gitDir, await treeOfIn(gitDir, parent), tree));
  }
  return paths;
};

/**
 * The tree a turn's own changes are measured from. What moving HEAD onto commits that
 * existed before the turn brought in (a clone, checkout, pull, reset, or a clean merge of
 * finished work) is not the turn's; everything it caused itself is:
 *
 * - every path a commit made during the turn changed (see `ownPaths`), however its content
 *   compares with older commits;
 * - uncommitted work (a path that differs from HEAD at the end);
 * - in a repository that existed before the turn, a path whose change is not exactly what
 *   HEAD's move did to it (uncommitted work before the turn, committed or discarded since).
 *
 * In a repository the turn created (cloned, initialized: `mayBeNew` when first seen
 * mid-turn), there is no meaningful "before": the baseline is the last commit HEAD's first
 * parents reach that the turn did not make (what it checked out), or the empty tree.
 * Elsewhere it is `before`. Paths brought in are then taken as they are `after`.
 * `startedAt` is when the turn started, in unix seconds.
 */
export const ownBaseline = async (
  repo: string,
  gitDir: string,
  before: Snapshot,
  after: Snapshot,
  startedAt: number,
  mayBeNew: boolean,
): Promise<string> => {
  if (!after.head || before.tree === after.tree) return before.tree;
  const born = before.head === null || (mayBeNew && ((await firstReflogTime(repo)) ?? 0) >= startedAt);
  if (!born && before.head === after.head) return before.tree;
  // The commits the turn made: reachable now, not before, committed since it started.
  const listed = await inGitDir(gitDir, ["rev-list", "--parents", `--since=@${startedAt}`, after.head, ...(before.head ? [`^${before.head}`] : []), "--"]);
  const commits = listed
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...parents] = line.trim().split(" ");
      return { sha: sha!, parents };
    });
  if (commits.length > MAX_OWN_COMMITS) return before.tree;
  const own = new Map(commits.map((c) => [c.sha, c]));
  let start = before.tree;
  if (born) {
    let at: string | undefined = after.head;
    while (at && own.has(at)) at = own.get(at)!.parents[0];
    start = at ? await treeOfIn(gitDir, at) : await inGitDir(gitDir, ["hash-object", "-t", "tree", "/dev/null"]).then((s) => s.trim());
  }
  const changed = await rawDiff(gitDir, start, after.tree);
  if (changed.size === 0) return start;
  const authored = await ownPaths(gitDir, commits);
  const headTree = await treeOfIn(gitDir, after.head);
  const uncommitted = await rawDiff(gitDir, headTree, after.tree);
  const moved = born ? null : await rawDiff(gitDir, await treeOfIn(gitDir, before.head!), headTree);
  const imported = [...changed].filter(
    ([path, entry]) => !authored.has(path) && !uncommitted.has(path) && (born || sameChange(entry, moved!.get(path))),
  );
  // Renames git sees from the start to the end, where they touch the turn's own work. Any
  // doubt here leaves a file shown whole (added, deleted): more to read, nothing hidden.
  const isImported = new Set(imported.map(([path]) => path));
  const gone = imported.filter(([, e]) => e.dstMode === "000000").map(([path]) => path);
  const created = [...changed].filter(([path, e]) => e.srcMode === "000000" && !isImported.has(path)).map(([path]) => path);
  const ownGone = [...changed].filter(([path, e]) => e.dstMode === "000000" && authored.has(path)).map(([path]) => path);
  const renames = (gone.length > 0 && created.length > 0) || ownGone.length > 0 ? await renamesBetween(gitDir, start, after.tree) : new Map();
  // - An own file (a conflict resolved in it) that the other side of the turn's own merge
  //   brought under this path by a rename: measured from the rename's source, not from
  //   nothing. Only when that imported side really has the path (a commit the turn did not
  //   make, parent of one it made): a similar file the turn created is its own, added.
  if (gone.length > 0 && created.length > 0) {
    const importedParents = [...new Set(commits.flatMap((c) => c.parents).filter((p) => !own.has(p)))];
    for (const path of created) {
      const from = renames.get(path);
      if (!from || !gone.includes(from.path)) continue;
      const brought = await Promise.all(importedParents.map((p) => inGitDir(gitDir, ["cat-file", "-e", `${p}:${path}`]).then(() => true, () => false)));
      if (brought.some(Boolean)) imported.push([path, { srcMode: "000000", dstMode: from.mode, src: "", dst: from.object }]);
    }
  }
  // - An own edit to a file that an imported rename then moved: the destination is not
  //   imported whole (that would hide the edit), so the file shows as moved, with the edit.
  if (ownGone.length > 0) {
    const carried = new Set([...renames].filter(([, from]) => ownGone.includes(from.path)).map(([to]) => to));
    for (let i = imported.length - 1; i >= 0; i--) if (carried.has(imported[i]![0])) imported.splice(i, 1);
  }
  if (imported.length === 0) return start;
  const scratch = mkdtempSync(join(tmpdir(), "apollo-baseline-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    await git(tmpdir(), ["--git-dir", gitDir, "read-tree", start], env);
    const zeros = "0".repeat(start.length);
    const info = imported.map(([path, e]) => (e.dstMode === "000000" ? `0 ${zeros}\t${path}` : `${e.dstMode} ${e.dst}\t${path}`)).join("\0");
    await gitWithInput(tmpdir(), ["--git-dir", gitDir, "update-index", "-z", "--index-info"], `${info}\0`, env);
    return (await git(tmpdir(), ["--git-dir", gitDir, "write-tree"], env)).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** Whether a path has the same mode and content in two trees. */
export const samePathIn = async (gitDir: string, a: string, pathA: string, b: string, pathB: string) => {
  const entry = (tree: string, path: string) => inGitDir(gitDir, ["ls-tree", "-z", tree, "--", path]).then((s) => s.split("\t")[0] ?? "", () => null);
  const [x, y] = await Promise.all([entry(a, pathA), entry(b, pathB)]);
  return x !== null && x !== "" && x === y;
};

/** The unified diff of one file between two snapshots. */
export const diffFile = (gitDir: string, before: string, after: string, path: string, oldPath: string | null) =>
  inGitDir(gitDir, ["diff", "--no-ext-diff", "--no-color", "-M", "-U3", before, after, "--", ...(oldPath ? [oldPath] : []), path]);

/** A file's content in a snapshot, or null when it is not there. */
export const fileAt = (gitDir: string, tree: string, path: string): Promise<string | null> =>
  inGitDir(gitDir, ["cat-file", "blob", `${tree}:${path}`]).catch(() => null);

/** Absolute paths mentioned in a tool call's summary (`/a/b`, `~/c`), for finding the repos it touches. */
export const pathsIn = (text: string, home: string, cwd: string): Array<string> => {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s"'=(:,])((?:~|\/)[^\s"'`;|&<>(),]+)/g)) {
    const raw = match[1]!;
    const path = raw.startsWith("~") ? join(home, raw.slice(1)) : raw;
    if (isAbsolute(path) && path.length > 1) found.add(path);
  }
  for (const match of text.matchAll(/\bcd\s+([^\s;&|]+)/g)) found.add(resolve(cwd, match[1]!.replace(/^~/, home)));
  return [...found];
};

// --- a repository against its baseline (the user-requested full diff) ----------------

/** Refs longer than this are refused (they are shown, and stored with the report). */
export const MAX_REF_LENGTH = 256;

const verifyCommit = (repo: string, ref: string, signal?: AbortSignal) =>
  git(repo, ["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`], undefined, signal).then(
    (s) => s.trim() || null,
    (error) => (signal?.aborted ? Promise.reject(error) : null),
  );

/**
 * The empty tree in the repository's own object format (SHA-1 or SHA-256): the baseline
 * of a repository without commits. Writing it is harmless (git knows it anyway).
 */
const emptyTree = async (repo: string, signal?: AbortSignal) =>
  (await git(repo, ["hash-object", "-w", "-t", "tree", "/dev/null"], undefined, signal)).trim();

/** The merge base of two commits, or null when their histories share no commit. */
const mergeBase = (repo: string, a: string, b: string, signal?: AbortSignal) =>
  git(repo, ["merge-base", a, b], undefined, signal).then(
    (s) => s.trim() || null,
    (error) => {
      // Exit code 1 without a message: no common ancestor. Anything else is a real failure.
      if (error instanceof GitError && error.code === 1 && error.stderr === "") return null;
      throw error;
    },
  );

/** Where a repository's work started: what a full diff compares the working tree against. */
export interface Baseline {
  /** The ref as asked for or picked (`origin/main`), for display. */
  readonly ref: string;
  /** The merge base of HEAD and that ref; null for a repository without commits. */
  readonly commit: string | null;
  readonly tree: string;
}

const DEFAULT_BASES = ["origin/main", "origin/master", "@{upstream}", "main", "master"];

/**
 * What Apollo recorded when it created a worker's worktree: its branch, the commit it was
 * created at, and the branch that commit was on.
 */
export interface WorkerFork {
  readonly branch: string;
  readonly baseRef: string;
  readonly baseBranch: string | null;
}

/** Whether `a` is an ancestor of `b` (or the same commit). */
const isAncestor = (repo: string, a: string, b: string, signal?: AbortSignal) =>
  git(repo, ["merge-base", "--is-ancestor", a, b], undefined, signal).then(
    () => true,
    (error) => {
      if (error instanceof GitError && error.code === 1) return false;
      throw error;
    },
  );

/**
 * HEAD's branch, and the commit it was created at when its reflog still says so (`git
 * branch`, `checkout -b` and `worktree add -b` write "branch: Created from ..."; an expired
 * or cloned log does not).
 */
const branchStart = async (repo: string, pinned: string | null | undefined, signal?: AbortSignal): Promise<{ branch: string | null; start: string | null }> => {
  const branch =
    pinned !== undefined
      ? pinned
      : await git(repo, ["symbolic-ref", "-q", "--short", "HEAD"], undefined, signal).then(
          (s) => s.trim() || null,
          (error) => (signal?.aborted ? Promise.reject(error) : null),
        );
  if (!branch) return { branch, start: null };
  const log = await git(repo, ["reflog", "show", "--format=%H%x09%gs", `refs/heads/${branch}`, "--"], undefined, signal).catch((error) =>
    signal?.aborted ? Promise.reject(error) : "",
  );
  const [sha, subject] = (log.trim().split("\n").at(-1) ?? "").split("\t");
  return { branch, start: sha && subject?.startsWith("branch: Created from") ? sha : null };
};

/**
 * Whether `base` contains work of the branch's own since `start` (its first parents): a
 * commit, or a merge holding a conflict resolution or an edit (see `mergeOwnDelta`; one
 * that cannot be told counts). A clean merge does not: a base branch that absorbed it is
 * still a fair baseline, and refusing it could hide a later commit that undoes what it
 * brought in.
 */
const baseHoldsOwnWork = async (repo: string, head: string, start: string, base: string, signal?: AbortSignal) => {
  const list = (...args: Array<string>) => git(repo, ["rev-list", "--first-parent", "--parents", head, `^${start}`, ...args, "--"], undefined, signal);
  const outside = new Set((await list(`^${base}`)).split("\n").map((line) => line.split(" ")[0]));
  const contained = (await list())
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().split(" "))
    .filter(([sha]) => !outside.has(sha));
  if (contained.length === 0) return false;
  const gitDir = await commonGitDir(repo, signal);
  for (const [sha, ...parents] of contained) {
    if (parents.length < 2) return true;
    const delta = await mergeOwnDelta(gitDir, parents, await treeOf(repo, sha!, signal), signal);
    if (delta === null || delta.size > 0) return true;
  }
  return false;
};

/**
 * The baseline of a full diff at commit `head` (HEAD, read once by the caller): the merge
 * base of `head` with `ref` or, by default, with the first of the origin's default branch
 * (`origin/HEAD`), `origin/main`, `origin/master`, the branch's upstream, `main`, `master`
 * that exists and shares history with it; `head` itself when none does (only uncommitted
 * work then, and the ref says "HEAD"). The merge base keeps others' later commits on that
 * branch out. An explicit `ref` without shared history is refused: there is nothing honest
 * to compare against.
 *
 * By default, work that HEAD's branch started from rather than did is left out too: the
 * baseline moves to a nearer merge base (shown with its own label) with
 *
 * - the commit the branch was created at (its reflog), or
 * - for a worker's worktree (`worker`, what Apollo recorded), the branch it was created from
 *   as that branch is now (work merged in from it since is not the worker's either), and
 *   its recorded start. Only when it provably describes this checkout: HEAD is on the
 *   worker's branch, the recorded start is an ancestor of HEAD, and the branch's reflog, if
 *   it still says where the branch was created, says the same.
 *
 * Never to a commit that contains any of the branch's own commits since it started: that
 * would hide its work (its base branch merged it, say).
 *
 * `branch` is HEAD's branch as read with `head` (null when detached), so that both describe
 * one state; the caller checks that neither moved. Read here when not given.
 */
export const resolveBaseline = async (
  repo: string,
  head: string | null,
  ref?: string,
  signal?: AbortSignal,
  worker?: WorkerFork,
  branch?: string | null,
): Promise<Baseline> => {
  const wanted = ref?.trim();
  if (ref !== undefined && (!wanted || wanted.startsWith("-") || wanted.length > MAX_REF_LENGTH)) {
    throw new Error(`"${ref.slice(0, 80)}" is not a git ref`);
  }
  if (wanted) {
    const target = await verifyCommit(repo, wanted, signal);
    if (!target) throw new Error(`Unknown ref "${wanted}" in ${repo}`);
    if (!head) throw new Error(`${repo} has no commits yet: there is nothing to compare with "${wanted}"`);
    const base = target === head ? head : await mergeBase(repo, head, target, signal);
    if (!base) throw new Error(`"${wanted}" shares no history with HEAD in ${repo}: there is no merge base to compare against`);
    return { ref: wanted, commit: base, tree: await treeOf(repo, base, signal) };
  }
  if (!head) return { ref: "(no commits)", commit: null, tree: await emptyTree(repo, signal) };
  const originHead = await git(repo, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], undefined, signal).then(
    (s) => s.trim(),
    (error) => (signal?.aborted ? Promise.reject(error) : ""),
  );
  for (const candidate of new Set([originHead, ...DEFAULT_BASES])) {
    if (!candidate) continue;
    const target = await verifyCommit(repo, candidate, signal);
    if (!target) continue;
    const base = target === head ? head : await mergeBase(repo, head, target, signal);
    if (!base) continue;
    let chosen = { ref: candidate, commit: base };
    if (chosen.commit === head) return { ...chosen, tree: await treeOf(repo, head, signal) };
    // Each fork: where to compare, how to show it, and where the branch's own work starts.
    const forks: Array<{ ref: string; label: string; start: string }> = [];
    const { branch: onBranch, start } = await branchStart(repo, branch, signal);
    if (onBranch && start) forks.push({ ref: start, label: `start of ${onBranch}`, start });
    const recorded = worker && (await verifyCommit(repo, worker.baseRef, signal));
    if (
      worker &&
      recorded &&
      onBranch === worker.branch &&
      (start === null || start === recorded) &&
      (await isAncestor(repo, recorded, head, signal))
    ) {
      if (worker.baseBranch) forks.push({ ref: `refs/heads/${worker.baseBranch}`, label: worker.baseBranch, start: recorded });
      forks.push({ ref: recorded, label: `start of ${onBranch}`, start: recorded });
    }
    for (const fork of forks) {
      const at = await verifyCommit(repo, fork.ref, signal);
      const nearer = at && (at === head ? head : await mergeBase(repo, head, at, signal));
      if (!nearer || nearer === chosen.commit || !(await isAncestor(repo, chosen.commit, nearer, signal))) continue;
      if (await baseHoldsOwnWork(repo, head, fork.start, nearer, signal)) continue;
      chosen = { ref: fork.label, commit: nearer };
    }
    return { ...chosen, tree: await treeOf(repo, chosen.commit, signal) };
  }
  return { ref: "HEAD", commit: head, tree: await treeOf(repo, head, signal) };
};

const treeOf = async (repo: string, commit: string, signal?: AbortSignal) =>
  (await git(repo, ["rev-parse", `${commit}^{tree}`], undefined, signal)).trim();

/** HEAD's commit and tree, and its branch (null when detached or without commits). */
export const headOf = async (repo: string, signal?: AbortSignal) => {
  const commit = await verifyCommit(repo, "HEAD", signal);
  const branch = await git(repo, ["symbolic-ref", "-q", "--short", "HEAD"], undefined, signal).then(
    (s) => s.trim() || null,
    (error) => (signal?.aborted ? Promise.reject(error) : null),
  );
  return { commit, branch, tree: commit ? await treeOf(repo, commit, signal) : await emptyTree(repo, signal) };
};

/** HEAD's commit now (null without commits). */
export const headCommit = (repo: string, signal?: AbortSignal) => verifyCommit(repo, "HEAD", signal);

/** Commit subjects longer than this are cut (they are stored with the report). */
export const MAX_SUBJECT_LENGTH = 200;

/** The commits from `base` to `head` (newest first, at most `limit`), and how many there are. */
export const commitsBetween = async (repo: string, base: string | null, head: string | null, limit: number, signal?: AbortSignal) => {
  if (!head) return { count: 0, commits: [] as Array<{ sha: string; subject: string }> };
  const range = base ? `${base}..${head}` : head;
  const [count, log] = await Promise.all([
    git(repo, ["rev-list", "--count", range], undefined, signal),
    git(repo, ["log", "--no-color", `--max-count=${limit}`, "--format=%h%x09%s", range], undefined, signal),
  ]);
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const subject = line.slice(tab + 1);
      return { sha: line.slice(0, tab), subject: subject.length > MAX_SUBJECT_LENGTH ? `${subject.slice(0, MAX_SUBJECT_LENGTH - 1)}…` : subject };
    });
  return { count: Number(count.trim()) || 0, commits };
};
