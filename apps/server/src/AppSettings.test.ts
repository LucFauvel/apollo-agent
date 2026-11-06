import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AppSettings, expandPath, layer as appSettingsLayer, scanFolder } from "./AppSettings.ts";
import * as Database from "./Database.ts";
import * as Store from "./Store.ts";

const layer = appSettingsLayer.pipe(Layer.provideMerge(Store.layer), Layer.provideMerge(Database.layerMemory));

/** ~/git-like folder: two repos, a grouping folder with one more, a manifest-only project and noise. */
const makeTree = () => {
  const root = mkdtempSync(join(tmpdir(), "apollo-projects-"));
  mkdirSync(join(root, "alpha/.git"), { recursive: true });
  mkdirSync(join(root, "beta/.git"), { recursive: true });
  mkdirSync(join(root, "org/gamma/.git"), { recursive: true });
  mkdirSync(join(root, "delta"), { recursive: true });
  writeFileSync(join(root, "delta/package.json"), "{}");
  mkdirSync(join(root, "notes/deep/deeper/.git"), { recursive: true });
  mkdirSync(join(root, ".hidden/.git"), { recursive: true });
  mkdirSync(join(root, "node_modules/x/.git"), { recursive: true });
  return root;
};

describe("AppSettings", () => {
  it("expands ~ and normalizes paths", () => {
    expect(expandPath("~", "/home/me")).toBe("/home/me");
    expect(expandPath("~/git/", "/home/me")).toBe("/home/me/git");
    expect(expandPath("/a/b/../c", "/home/me")).toBe("/a/c");
    expect(expandPath("relative", "/home/me")).toBe("relative");
  });

  it("finds git repos and manifest projects two levels deep", async () => {
    const root = makeTree();
    const found = await scanFolder(root);
    expect(found.map((p) => [p.name, p.git])).toEqual([
      ["alpha", true],
      ["beta", true],
      ["delta", false],
      ["gamma", true],
    ]);
    expect(found.every((p) => p.folder === root)).toBe(true);
  });

  it.effect("saves project folders and rejects missing ones", () =>
    Effect.gen(function* () {
      const settings = yield* AppSettings;
      const root = makeTree();
      const initial = yield* settings.read;
      expect(initial.projectFolders).toEqual([]);
      expect(initial.workspaceRoot).toBe(join(initial.homeDir, "Apollo"));

      const saved = yield* settings.update({ projectFolders: [root, `${root}/`], workspaceRoot: "~/Bots" });
      expect(saved.projectFolders).toEqual([root]);
      expect(saved.workspaceRoot).toBe(join(saved.homeDir, "Bots"));
      expect((yield* settings.projects).map((p) => p.name)).toEqual(["alpha", "beta", "delta", "gamma"]);

      const missing = yield* settings.update({ projectFolders: [join(root, "nope")] }).pipe(Effect.flip);
      expect(missing.message).toContain("not a folder");
      const relative = yield* settings.update({ workspaceRoot: "bots" }).pipe(Effect.flip);
      expect(relative.message).toContain("full path");
      expect((yield* settings.read).projectFolders).toEqual([root]);
    }).pipe(Effect.provide(layer)),
  );
});
