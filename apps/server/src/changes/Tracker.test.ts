import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Database from "../Database.ts";
import { makeChangeTracker } from "./Tracker.ts";

const repo = (name: string) => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "apollo-tracker-"))), name);
  mkdirSync(dir);
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(dir, "store.ts"), "export class Store {\n  list() {\n    return [];\n  }\n}\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, git };
};

const setup = () => {
  const db = Database.open(":memory:");
  db.exec("pragma foreign_keys = off"); // no sessions table rows in this test
  return { db, tracker: makeChangeTracker(db, "/nonexistent-home") };
};

describe("change tracker", () => {
  it("detects a turn's changes in its repositories, without touching the index", async () => {
    const { tracker } = setup();
    const app = repo("app");
    const lib = repo("lib");
    // A change the user made before the turn: not the turn's.
    writeFileSync(join(app.dir, "notes.md"), "# Notes\n");

    await tracker.turnStarted("s1", 7, app.dir);
    writeFileSync(join(app.dir, "store.ts"), "export class Store {\n  list() {\n    return ['a'];\n  }\n\n  add(x: string) {\n    return x;\n  }\n}\n");
    writeFileSync(join(app.dir, "new.ts"), "export const answer = 42;\n");
    mkdirSync(join(app.dir, "node_modules"));
    writeFileSync(join(app.dir, "node_modules", "ignored.js"), "x\n");
    // A tool call in another repository: watched from then on.
    await tracker.toolStarted("s1", `${join(lib.dir, "store.ts")}`);
    rmSync(join(lib.dir, "store.ts"));

    const done = await tracker.turnCompleted("s1");
    expect(done?.seq).toBe(7);
    expect(done!.repos.map((r) => [r.name, r.files.map((f) => [f.path, f.status, f.additions, f.deletions])])).toEqual([
      ["app", [["new.ts", "added", 1, 0], ["store.ts", "modified", 5, 1]]],
      ["lib", [["store.ts", "deleted", 0, 5]]],
    ]);
    // The user's index is untouched: nothing is staged.
    expect(app.git("diff", "--cached", "--name-only")).toBe("");
  });

  it("keeps workers' explanations and shows a semantic diff of the session's changes", async () => {
    const { tracker } = setup();
    const app = repo("app");
    await tracker.turnStarted("s2", 3, app.dir);
    writeFileSync(join(app.dir, "store.ts"), "export class Store {\n  list() {\n    return ['a'];\n  }\n}\n");
    const explained = await tracker.explain("s2", "Lists start with a default.", [
      { path: "store.ts", explanation: "Default entry.", symbols: [{ name: "list", explanation: "Returns the default." }] },
      { path: "missing.ts", explanation: "?" },
    ]);
    expect(explained).toMatchObject({ attached: 1, unknown: ["missing.ts"], changed: ["app/store.ts"] });
    await tracker.turnCompleted("s2");

    const overview = await tracker.sessionChanges("s2", "Worker");
    expect(overview).toMatchObject({
      title: "Worker",
      repos: [{ name: "app", files: [{ path: "store.ts", status: "modified", note: "Default entry." }] }],
      summaries: [{ text: "Lists start with a default." }],
    });
    const diff = await tracker.file("s2", app.dir, "store.ts");
    expect(diff?.symbols.map((s) => [s.name, s.change, s.note])).toEqual([["Store.list", "modified", "Returns the default."]]);
    expect(tracker.turnNotes("s2", 3).map((n) => n.text)).toEqual(["Lists start with a default.", "Default entry.", "Returns the default."]);
  });

  it("spans several turns, from the first snapshot to the latest", async () => {
    const { tracker } = setup();
    const app = repo("app");
    await tracker.turnStarted("s3", 1, app.dir);
    writeFileSync(join(app.dir, "a.ts"), "export const a = 1;\n");
    await tracker.turnCompleted("s3");
    await tracker.turnStarted("s3", 2, app.dir);
    writeFileSync(join(app.dir, "b.ts"), "export const b = 2;\n");
    await tracker.turnCompleted("s3");
    const overview = await tracker.sessionChanges("s3", "Worker");
    expect(overview?.repos[0]?.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });
});
