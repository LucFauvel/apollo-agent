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
