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
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.code = code;
    this.stderr = stderr;
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
const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv, signal?: AbortSignal) =>
  new Promise<string>((resolvePromise, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const command = `git ${args[0] ?? ""}`;
    const child = spawn("git", [...args], {
      cwd,
      env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
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
      child.stdout.destroy();
      child.stderr.destroy();
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
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));

    const finish = (code: number | null) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (stopped) settle({ error: stopped });
      else if (code !== 0) settle({ error: new GitError(stderr || `${command} exited with ${code}`, code, stderr) });
      else settle({ value: stdout });
    };
    child.once("error", (error) => settle({ error: stopped ?? new GitError(error.message, null, "") }));
    // Normally the pipes close right after git exits; when something else holds them, settle anyway.
    child.once("exit", (code) => later(EXIT_DRAIN_MS, () => finish(code)));
    child.once("close", (code) => finish(code));
  });

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
 * The baseline of a full diff at commit `head` (HEAD, read once by the caller): the merge
 * base of `head` with `ref` or, by default, with the first of the origin's default branch
 * (`origin/HEAD`), `origin/main`, `origin/master`, the branch's upstream, `main`, `master`
 * that exists and shares history with it; `head` itself when none does (only uncommitted
 * work then, and the ref says "HEAD"). The merge base keeps others' later commits on that
 * branch out. An explicit `ref` without shared history is refused: there is nothing honest
 * to compare against.
 */
export const resolveBaseline = async (repo: string, head: string | null, ref?: string, signal?: AbortSignal): Promise<Baseline> => {
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
    if (base) return { ref: candidate, commit: base, tree: await treeOf(repo, base, signal) };
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
