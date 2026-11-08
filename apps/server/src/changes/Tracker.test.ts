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

/** Clones and commits: slow when the whole suite runs in parallel. */
const GIT_HEAVY = 30_000;

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

  describe("full diff against the baseline", () => {
    /** A clone of `app` whose origin is a bare copy: origin/HEAD points at main. */
    const cloned = () => {
      const app = repo("app");
      app.git("branch", "-M", "main");
      const root = realpathSync(mkdtempSync(join(tmpdir(), "apollo-report-")));
      execFileSync("git", ["clone", "-q", "--bare", app.dir, join(root, "origin.git")]);
      execFileSync("git", ["clone", "-q", join(root, "origin.git"), join(root, "work")]);
      const dir = join(root, "work");
      const git = (...args: Array<string>) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      return { dir, git };
    };

    it("covers commits since the merge base and uncommitted work, whichever turn made them", async () => {
      const { db, tracker } = setup();
      const work = cloned();
      work.git("checkout", "-qb", "feature");
      // Committed in an earlier turn (or by hand): not pushed.
      writeFileSync(join(work.dir, "store.ts"), "export class Store {\n  list() {\n    return ['a'];\n  }\n}\n");
      work.git("commit", "-qam", "Default entry");
      work.git("mv", "store.ts", "repo.ts");
      work.git("commit", "-qm", "Rename");
      // Uncommitted, and untracked.
      writeFileSync(join(work.dir, "new.ts"), "export const answer = 42;\n");
      // A worker explained repo.ts in some session that worked in this repository.
      await tracker.turnStarted("s4", 1, work.dir);
      writeFileSync(join(work.dir, "repo.ts"), "export class Store {\n  list() {\n    return ['b'];\n  }\n}\n");
      await tracker.explain("s4", "", [{ path: "repo.ts", explanation: "Lists start with b.", symbols: [{ name: "list", explanation: "b, not a." }] }]);
      await tracker.turnCompleted("s4");

      const { repo: changes, report } = await tracker.report(join(work.dir, "repo.ts"));
      expect(report.base.ref).toBe("origin/main");
      expect(report.base.commit).toBe(work.git("rev-parse", "origin/main").trim());
      expect(report.head.branch).toBe("feature");
      expect([report.commitCount, report.commits.map((c) => c.subject)]).toEqual([2, ["Rename", "Default entry"]]);
      expect(report.uncommitted).toBe(true);
      expect(changes.files.map((f) => [f.path, f.status, f.oldPath])).toEqual([
        ["new.ts", "added", null],
        ["repo.ts", "renamed", "store.ts"],
      ]);
      expect(report.notes).toEqual([{ path: "repo.ts", text: "Lists start with b." }]);

      const diff = await tracker.reportFile(changes.repo, report, "repo.ts");
      expect(diff?.symbols.map((s) => [s.name, s.change, s.note])).toEqual([["Store.list", "modified", "b, not a."]]);
      expect(await tracker.reportFile(changes.repo, report, "nope.ts")).toBeNull();
      // The user's index and checkout are untouched.
      expect(work.git("diff", "--cached", "--name-only")).toBe("");
      expect(work.git("status", "--porcelain")).toContain("?? new.ts");
      db.close();
    }, GIT_HEAVY);

    it("takes an explicit base, and refuses one that is not a ref", async () => {
      const { tracker } = setup();
      const work = cloned();
      writeFileSync(join(work.dir, "a.ts"), "export const a = 1;\n");
      work.git("add", "-A");
      work.git("commit", "-qm", "a");
      writeFileSync(join(work.dir, "b.ts"), "export const b = 2;\n");
      work.git("add", "-A");
      work.git("commit", "-qm", "b");
      const { repo: changes, report } = await tracker.report(work.dir, "HEAD~1");
      expect(report.base.ref).toBe("HEAD~1");
      expect([report.commitCount, report.uncommitted]).toEqual([1, false]);
      expect(changes.files.map((f) => f.path)).toEqual(["b.ts"]);
      await expect(tracker.report(work.dir, "--output=/tmp/x")).rejects.toThrow("is not a git ref");
      await expect(tracker.report(work.dir, "no-such-branch")).rejects.toThrow('Unknown ref "no-such-branch"');
    }, GIT_HEAVY);

    it("falls back to HEAD without a remote, and to the empty tree without commits", async () => {
      const { tracker } = setup();
      const app = repo("app");
      writeFileSync(join(app.dir, "store.ts"), "export class Store {}\n");
      // "main"/"master" may not exist depending on init.defaultBranch: either way, only uncommitted work shows.
      const local = await tracker.report(app.dir);
      expect(local.report.commitCount).toBe(0);
      expect(local.repo.files.map((f) => f.path)).toEqual(["store.ts"]);

      const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "apollo-empty-"))), "empty");
      mkdirSync(dir);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "first.ts"), "export const first = 1;\n");
      const empty = await tracker.report(dir);
      expect(empty.report.base).toMatchObject({ commit: null, tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });
      expect(empty.repo.files.map((f) => [f.path, f.status])).toEqual([["first.ts", "added"]]);
      await expect(tracker.report(tmpdir())).rejects.toThrow("is not in a git repository");
    }, GIT_HEAVY);
  });
});
