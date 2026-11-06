import { ApolloError, type AppSettings as AppSettingsView, type ProjectInfo, type UpdateAppSettingsInput } from "@apollo/contracts";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Store } from "./Store.ts";

const KEYS = {
  projectFolders: "app.projectFolders",
  workspaceRoot: "app.workspaceRoot",
} as const;

/** Files that mark a folder as a project, besides `.git`. */
const MANIFESTS = new Set([
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Package.swift",
  "CMakeLists.txt",
  "Makefile",
  "deno.json",
  "mix.exs",
  "pubspec.yaml",
]);
const SKIP = new Set(["node_modules", "Library", "Applications", "Pictures", "Music", "Movies"]);
const MAX_PROJECTS = 500;
const CACHE_MS = 30_000;

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

/** Expands `~`, resolves `.` segments and drops a trailing slash. */
export const expandPath = (path: string, home = homedir()) => {
  const trimmed = path.trim();
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? normalize(resolve(expanded)) : expanded;
};

const isDirectory = (path: string) =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );

const entriesOf = (path: string) =>
  readdir(path, { withFileTypes: true }).catch(() => [] as Array<import("node:fs").Dirent>);

/**
 * Finds projects in a folder: children that are git repos or have a project
 * manifest, plus one more level for grouping folders like `~/git/<org>/<repo>`.
 */
export const scanFolder = async (folder: string, limit = MAX_PROJECTS): Promise<Array<ProjectInfo>> => {
  const found: Array<ProjectInfo> = [];
  const visit = async (dir: string, depth: number) => {
    for (const entry of await entriesOf(dir)) {
      if (found.length >= limit) return;
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      const children = await entriesOf(path);
      const git = children.some((c) => c.name === ".git");
      if (git || children.some((c) => c.isFile() && MANIFESTS.has(c.name))) {
        found.push({ name: entry.name, path, folder, git });
      } else if (depth < 1) {
        await visit(path, depth + 1);
      }
    }
  };
  await visit(folder, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
};

const make = Effect.gen(function* () {
  const store = yield* Store;
  const home = homedir();
  let cache: { at: number; key: string; projects: ReadonlyArray<ProjectInfo> } | null = null;

  const read = Effect.gen(function* () {
    const folders = yield* store.getSetting(KEYS.projectFolders);
    const root = yield* store.getSetting(KEYS.workspaceRoot);
    let projectFolders: Array<string> = [];
    try {
      const parsed: unknown = folders ? JSON.parse(folders) : [];
      if (Array.isArray(parsed)) projectFolders = parsed.filter((f): f is string => typeof f === "string");
    } catch {}
    return {
      projectFolders,
      workspaceRoot: root ?? join(home, "Apollo"),
      homeDir: home,
    } satisfies AppSettingsView;
  });

  const update = (input: UpdateAppSettingsInput) =>
    Effect.gen(function* () {
      if (input.projectFolders !== undefined) {
        const folders = [...new Set(input.projectFolders.map((f) => expandPath(f, home)).filter(Boolean))];
        for (const folder of folders) {
          if (!isAbsolute(folder)) return yield* Effect.fail(invalid(`use a full path: ${folder}`));
          if (!(yield* Effect.promise(() => isDirectory(folder)))) {
            return yield* Effect.fail(invalid(`not a folder: ${folder}`));
          }
        }
        yield* store.setSetting(KEYS.projectFolders, JSON.stringify(folders));
        cache = null;
      }
      if (input.workspaceRoot !== undefined) {
        const root = expandPath(input.workspaceRoot, home);
        if (!root) yield* store.setSetting(KEYS.workspaceRoot, null);
        else if (!isAbsolute(root)) return yield* Effect.fail(invalid(`use a full path: ${root}`));
        else yield* store.setSetting(KEYS.workspaceRoot, root);
      }
      return yield* read;
    });

  /** Projects across all project folders, cached briefly. */
  const projects = Effect.gen(function* () {
    const { projectFolders } = yield* read;
    const key = projectFolders.join("\n");
    if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.projects;
    const lists = yield* Effect.promise(() => Promise.all(projectFolders.map((f) => scanFolder(f))));
    const all = lists.flat();
    cache = { at: Date.now(), key, projects: all };
    return all;
  });

  return { read, update, projects, expand: (path: string) => expandPath(path, home) };
});

export class AppSettings extends Context.Service<AppSettings, Effect.Success<typeof make>>()("apollo/AppSettings") {}

export const layer = Layer.effect(AppSettings, make);
