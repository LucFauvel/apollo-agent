import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactKind } from "@apollo/contracts";
import { classify } from "./artifacts.ts";

/** Folders a session's links may open files from: its own folder, its bot's workspace, the user's project folders. */
export interface FileRoots {
  readonly sessionCwd: string;
  readonly roots: ReadonlyArray<string>;
  readonly home: string;
}

export interface LocalFileInfo {
  readonly path: string;
  readonly name: string;
  readonly directory: boolean;
  readonly size: number;
  readonly modifiedAt: number;
  readonly kind: ArtifactKind;
  readonly mime: string;
  readonly language?: string;
}

export type ResolvedFile = { readonly ok: true; readonly info: LocalFileInfo } | { readonly ok: false; readonly reason: "missing" | "outside" };

const realOrNull = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..");
};

const sample = (path: string) => {
  const fd = openSync(path, "r");
  try {
    const bytes = new Uint8Array(64 * 1024);
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0));
  } finally {
    closeSync(fd);
  }
};

/**
 * Resolves a path a message mentions (absolute, `~/…`, `file://…`, or relative to the
 * session's folder) to a file or folder on disk, following symlinks, and refuses anything
 * whose real location is outside the session's roots.
 */
export const resolveLocalFile = (raw: string, roots: FileRoots): ResolvedFile => {
  let path = raw.trim();
  if (!path || path.includes("\0")) return { ok: false, reason: "missing" };
  if (/^file:/i.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      return { ok: false, reason: "missing" };
    }
  }
  if (path === "~") path = roots.home;
  else if (path.startsWith("~/") || path.startsWith("~\\")) path = join(roots.home, path.slice(2));
  const absolute = resolve(roots.sessionCwd, path);
  const allowed = [roots.sessionCwd, ...roots.roots].map(realOrNull).filter((r): r is string => r !== null);
  const real = realOrNull(absolute);
  // Says nothing about whether files outside the roots exist.
  if (!real) return { ok: false, reason: [roots.sessionCwd, ...roots.roots, ...allowed].some((root) => inside(root, absolute)) ? "missing" : "outside" };
  if (!allowed.some((root) => inside(root, real))) return { ok: false, reason: "outside" };
  let stat;
  try {
    stat = statSync(real);
  } catch {
    return { ok: false, reason: "missing" };
  }
  const name = basename(real);
  if (stat.isDirectory()) {
    return { ok: true, info: { path: real, name, directory: true, size: 0, modifiedAt: stat.mtimeMs, kind: "file", mime: "inode/directory" } };
  }
  if (!stat.isFile()) return { ok: false, reason: "missing" };
  let bytes: Uint8Array;
  try {
    bytes = sample(real);
  } catch {
    return { ok: false, reason: "missing" };
  }
  const { kind, mime, language } = classify(name, bytes);
  return {
    ok: true,
    info: { path: real, name, directory: false, size: stat.size, modifiedAt: stat.mtimeMs, kind, mime, ...(language ? { language } : {}) },
  };
};

export const fileErrorMessage = (reason: "missing" | "outside") =>
  reason === "outside"
    ? "Apollo only opens files in the bot's workspace, this session's folder or your project folders."
    : "This file is not on disk.";
