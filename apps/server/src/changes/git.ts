import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Git plumbing for change tracking. A snapshot is a tree object of the working tree
 * (tracked and untracked files, minus ignored ones), written through a temporary copy of
 * the index: the user's own index and checkout are never touched.
 */

const MAX_BUFFER = 64 * 1024 * 1024;

const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  new Promise<string>((resolvePromise, reject) => {
    execFile("git", [...args], { cwd, env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: MAX_BUFFER, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolvePromise(stdout);
    });
  });

/** The repository (worktree) a path is in, or null. */
export const repoRoot = async (path: string): Promise<string | null> => {
  let dir = resolve(path);
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    // A path that does not exist yet (a file about to be written): look from its folder.
    while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
  }
  try {
    return (await git(dir, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
};

/** The repository's common git dir (shared by its worktrees), where snapshot trees are written. */
export const commonGitDir = async (repo: string) =>
  (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();

/** Tree operations run against the git dir, so they work after a worktree is removed. */
const inGitDir = (gitDir: string, args: ReadonlyArray<string>) => git(tmpdir(), ["--git-dir", gitDir, ...args]);

/** A tree object of the working tree as it is now. */
export const snapshot = async (repo: string): Promise<string> => {
  const scratch = mkdtempSync(join(tmpdir(), "apollo-snapshot-"));
  const index = join(scratch, "index");
  try {
    // Starting from the real index keeps its stat cache: only changed files are hashed.
    const real = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    if (existsSync(real)) copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index };
    await git(repo, ["add", "-A", "--", "."], env);
    return (await git(repo, ["write-tree"], env)).trim();
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
export const diffFiles = async (gitDir: string, before: string, after: string): Promise<Array<FileChange>> => {
  if (before === after) return [];
  const [names, numbers] = await Promise.all([
    inGitDir(gitDir, ["diff", "--no-ext-diff", "-M", "--name-status", "-z", before, after]),
    inGitDir(gitDir, ["diff", "--no-ext-diff", "-M", "--numstat", "-z", before, after]),
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

/** git's empty tree: the baseline of a repository with no commits yet. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const verifyCommit = (repo: string, ref: string) =>
  git(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).then((s) => s.trim() || null, () => null);

/** Where a repository's work started: what a full diff compares the working tree against. */
export interface Baseline {
  /** The ref as asked for or picked (`origin/main`), for display. */
  readonly ref: string;
  /** The merge base of HEAD and that ref; null for a repository without commits. */
  readonly commit: string | null;
  readonly tree: string;
}

/**
 * The baseline of a full diff: the merge base of HEAD with `ref` or, by default, with the
 * first of the origin's default branch (`origin/HEAD`), `origin/main`, `origin/master`,
 * the branch's upstream, `main`, `master` that exists; HEAD itself when none does (only
 * uncommitted work then). The merge base keeps others' later commits on that branch out.
 */
export const resolveBaseline = async (repo: string, ref?: string): Promise<Baseline> => {
  if (ref !== undefined && (ref.trim() === "" || ref.startsWith("-"))) throw new Error(`"${ref}" is not a git ref`);
  const head = await verifyCommit(repo, "HEAD");
  let label: string | null = null;
  let target: string | null = null;
  if (ref !== undefined) {
    target = await verifyCommit(repo, ref.trim());
    if (!target) throw new Error(`Unknown ref "${ref}" in ${repo}`);
    label = ref.trim();
  } else {
    const originHead = await git(repo, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).then((s) => s.trim(), () => "");
    for (const candidate of [originHead, "origin/main", "origin/master", "@{upstream}", "main", "master"]) {
      if (!candidate) continue;
      target = await verifyCommit(repo, candidate);
      if (target) {
        label = candidate;
        break;
      }
    }
  }
  if (!head) return { ref: label ?? "(no commits)", commit: null, tree: EMPTY_TREE };
  if (!target) return { ref: "HEAD", commit: head, tree: await treeOf(repo, head) };
  const base = target === head ? head : (await git(repo, ["merge-base", head, target]).then((s) => s.trim(), () => "")) || target;
  return { ref: label!, commit: base, tree: await treeOf(repo, base) };
};

const treeOf = async (repo: string, commit: string) => (await git(repo, ["rev-parse", `${commit}^{tree}`])).trim();

/** HEAD's commit and tree, and its branch (null when detached or without commits). */
export const headOf = async (repo: string) => {
  const commit = await verifyCommit(repo, "HEAD");
  const branch = await git(repo, ["symbolic-ref", "-q", "--short", "HEAD"]).then((s) => s.trim() || null, () => null);
  return { commit, branch, tree: commit ? await treeOf(repo, commit) : EMPTY_TREE };
};

/** The commits on HEAD since `base` (newest first, at most `limit`), and how many there are. */
export const commitsSince = async (repo: string, base: string | null, limit: number) => {
  const range = base ? `${base}..HEAD` : "HEAD";
  const head = await verifyCommit(repo, "HEAD");
  if (!head) return { count: 0, commits: [] as Array<{ sha: string; subject: string }> };
  const [count, log] = await Promise.all([
    git(repo, ["rev-list", "--count", range]),
    git(repo, ["log", "--no-color", `--max-count=${limit}`, "--format=%h%x09%s", range]),
  ]);
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
  return { count: Number(count.trim()) || 0, commits };
};
