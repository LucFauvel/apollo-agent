import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { SessionWorktree } from "@apollo/contracts";

/** Runs git and returns its stdout; a failure carries git's own message. */
export const git = (cwd: string, args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) => {
    execFile("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout);
    });
  });

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "work";

/**
 * Gives a worker its own checkout: a git worktree on a new branch from the repository's
 * current HEAD, under Apollo's data folder. Returns it and the folder the session should
 * work in (the same subfolder of the repo as `cwd`).
 */
export const createWorktree = async (
  dataDir: string,
  sessionId: string,
  cwd: string,
  title: string,
): Promise<{ worktree: SessionWorktree; cwd: string }> => {
  let repoPath: string;
  try {
    repoPath = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new Error(`${cwd} is not inside a git repository, so it cannot get its own worktree`);
  }
  const baseRef = (await git(repoPath, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  if (!baseRef) throw new Error(`${repoPath} has no commits yet; commit once before using worktrees`);
  const baseBranch = (await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const branch = `apollo/${slug(title)}-${randomBytes(2).toString("hex")}`;
  const root = join(dataDir, "worktrees");
  mkdirSync(root, { recursive: true });
  const path = join(root, sessionId);
  await git(repoPath, ["worktree", "add", "-b", branch, path, baseRef]);
  const subdir = relative(repoPath, cwd);
  return {
    worktree: { repoPath, path, branch, baseRef, baseBranch: baseBranch === "HEAD" ? null : baseBranch },
    cwd: subdir && !subdir.startsWith("..") ? join(path, subdir) : path,
  };
};

const lines = (text: string) => text.split("\n").map((l) => l.trimEnd()).filter(Boolean);

/** What a worktree has done: commits on its branch, uncommitted changes and a diff summary. */
export const worktreeStatus = async (w: SessionWorktree) => {
  if (!existsSync(w.path)) {
    return { ...w, exists: false, commits: [], uncommitted: [], diffStat: "" };
  }
  const [commits, uncommitted, diffStat] = await Promise.all([
    git(w.path, ["log", "--oneline", `${w.baseRef}..HEAD`]).then(lines),
    git(w.path, ["status", "--short"]).then(lines),
    git(w.path, ["diff", "--stat", w.baseRef]).then((t) => t.trim()),
  ]);
  return { ...w, exists: true, commits, uncommitted, diffStat };
};

/** Commits whatever is left uncommitted, so removing the worktree loses nothing. */
const saveWork = async (w: SessionWorktree) => {
  if (!existsSync(w.path)) return false;
  if (lines(await git(w.path, ["status", "--porcelain"])).length === 0) return false;
  await git(w.path, ["add", "-A"]);
  await git(w.path, ["commit", "-m", "Apollo: uncommitted work from the worker session", "--no-verify"]);
  return true;
};

const removeCheckout = async (w: SessionWorktree) => {
  if (existsSync(w.path)) await git(w.repoPath, ["worktree", "remove", "--force", w.path]);
  await git(w.repoPath, ["worktree", "prune"]).catch(() => undefined);
};

export type FinishAction = "merge" | "keep" | "discard";

/**
 * Ends a worktree:
 * - `merge`: merges its branch into whatever the main checkout has checked out, then
 *   deletes the branch. Refuses if the main checkout has uncommitted changes, and backs
 *   out of a conflicting merge, listing the files.
 * - `keep`: removes the checkout but keeps the branch (uncommitted work is committed first).
 * - `discard`: removes the checkout and deletes the branch.
 */
export const finishWorktree = async (w: SessionWorktree, action: FinishAction) => {
  if (action === "discard") {
    await removeCheckout(w);
    await git(w.repoPath, ["branch", "-D", w.branch]).catch(() => undefined);
    return { action, message: `Removed the worktree and deleted ${w.branch}.` };
  }
  const saved = await saveWork(w);
  if (action === "keep") {
    await removeCheckout(w);
    return { action, message: `Removed the worktree; its work stays on branch ${w.branch}${saved ? " (uncommitted changes were committed)" : ""}.` };
  }
  const dirty = lines(await git(w.repoPath, ["status", "--porcelain", "--untracked-files=no"]));
  if (dirty.length > 0) {
    throw new Error(
      `the main checkout at ${w.repoPath} has uncommitted changes (${dirty.slice(0, 5).join(", ")}); commit or stash them, or use "keep" and merge ${w.branch} yourself`,
    );
  }
  const target = (await git(w.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  try {
    await git(w.repoPath, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${w.branch} (Apollo worker)`, w.branch]);
  } catch (error) {
    const conflicts = lines(await git(w.repoPath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""));
    await git(w.repoPath, ["merge", "--abort"]).catch(() => undefined);
    throw new Error(
      conflicts.length > 0
        ? `merging ${w.branch} into ${target} conflicts in ${conflicts.join(", ")}; nothing was changed. Resolve it in the worktree (e.g. merge ${target} into ${w.branch} there) and try again`
        : `merging ${w.branch} failed: ${(error as Error).message}`,
    );
  }
  await removeCheckout(w);
  await git(w.repoPath, ["branch", "-d", w.branch]).catch(() => undefined);
  return { action, message: `Merged ${w.branch} into ${target}${saved ? " (uncommitted changes were committed first)" : ""} and removed the worktree.` };
};

/** When its session is deleted: keep the branch, so nothing is lost. */
export const retireWorktree = (w: SessionWorktree) => finishWorktree(w, "keep");
