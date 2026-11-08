import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Database from "../Database.ts";
import { MAX_REF_LENGTH, MAX_SUBJECT_LENGTH, snapshot } from "./git.ts";
import { makeChangeTracker, MAX_REPORT_FILES } from "./Tracker.ts";

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

    const overview = (await tracker.sessionChanges("s2", "Worker")).section;
    expect(overview).toMatchObject({
      title: "Worker",
      repos: [{ name: "app", files: [{ path: "store.ts", status: "modified", note: "Default entry." }] }],
      summaries: [{ text: "Lists start with a default." }],
    });
    const diff = await tracker.file("s2", app.dir, "store.ts");
    expect(diff?.symbols.map((s) => [s.name, s.change, s.note])).toEqual([["Store.list", "modified", "Returns the default."]]);
    expect(tracker.turnNotes("s2", 3).map((n) => n.text)).toEqual(["Lists start with a default.", "Default entry.", "Returns the default."]);
    // The conversation's card finds the summary by its turn; what is cleared is listed too.
    expect(tracker.conversation("s2")).toMatchObject({ summaries: [{ turnSeq: 3, text: "Lists start with a default." }], dismissed: [] });
    tracker.setDismissed("s2", 12, true);
    tracker.setDismissed("s2", 12, true);
    expect(tracker.conversation("s2").dismissed).toEqual([12]);
    tracker.setDismissed("s2", 12, false);
    expect(tracker.conversation("s2").dismissed).toEqual([]);
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
    const overview = (await tracker.sessionChanges("s3", "Worker")).section;
    expect(overview?.repos[0]?.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });

  describe("turns cleared from the Changes panel", () => {
    /** Runs a turn as SessionManager does: TurnStarted at `seq`, then its FilesChanged event. */
    const turn = async (
      db: ReturnType<typeof setup>["db"],
      tracker: ReturnType<typeof setup>["tracker"],
      sessionId: string,
      seq: number,
      dir: string,
      work: () => void,
      summary?: string,
      notes: ReadonlyArray<{ path: string; explanation: string }> = [],
    ) => {
      const event = db.prepare("insert into session_events (session_id, seq, at, event) values (?, ?, ?, ?)");
      event.run(sessionId, seq, seq, JSON.stringify({ _tag: "TurnStarted" }));
      await tracker.turnStarted(sessionId, seq, dir);
      work();
      if (summary || notes.length) await tracker.explain(sessionId, summary ?? "", notes);
      const done = await tracker.turnCompleted(sessionId);
      if (done?.repos.length) event.run(sessionId, seq + 5, seq + 5, JSON.stringify({ _tag: "FilesChanged", repos: done.repos }));
      return seq + 5;
    };
    const paths = (section: { repos: ReadonlyArray<{ files: ReadonlyArray<{ path: string }> }> } | null) =>
      section?.repos.flatMap((r) => r.files.map((f) => f.path)) ?? null;

    it("leaves cleared turns' files and summaries out, lists them, and brings them back", async () => {
      const { db, tracker } = setup();
      const app = repo("app");
      const first = await turn(db, tracker, "p1", 10, app.dir, () => writeFileSync(join(app.dir, "a.ts"), "export const a = 1;\n"), "Adds a.");
      const second = await turn(db, tracker, "p1", 30, app.dir, () => {
        writeFileSync(join(app.dir, "b.ts"), "export const b = 2;\n");
        // A full diff the user asked for during the turn (it carries a report): not the turn's changes.
        db.prepare("insert into session_events (session_id, seq, at, event) values (?, ?, ?, ?)").run(
          "p1",
          32,
          32,
          JSON.stringify({ _tag: "FilesChanged", repos: [], report: {} }),
        );
      }, "Adds b.");
      expect([first, second]).toEqual([15, 35]);
      let changes = await tracker.sessionChanges("p1", "Worker");
      expect(paths(changes.section)).toEqual(["a.ts", "b.ts"]);
      expect(changes.section?.turns).toEqual([15, 35]);
      expect(changes.cleared).toEqual([]);

      // The panel clears the first turn: only the second's file and summary are left.
      tracker.setDismissed("p1", first, true);
      changes = await tracker.sessionChanges("p1", "Worker");
      expect(paths(changes.section)).toEqual(["b.ts"]);
      expect(changes.section?.summaries.map((s) => s.text)).toEqual(["Adds b."]);
      expect(changes.section?.turns).toEqual([second]);
      expect(changes.cleared).toEqual([first]);
      expect(await tracker.file("p1", app.dir, "a.ts")).toBe(null);
      expect((await tracker.file("p1", app.dir, "b.ts"))?.status).toBe("added");

      // Both cleared: nothing to show, everything to bring back.
      tracker.setDismissed("p1", second, true);
      changes = await tracker.sessionChanges("p1", "Worker");
      expect(changes).toEqual({ section: null, cleared: [first, second] });

      // Undo brings them back as they were.
      tracker.setDismissed("p1", first, false);
      tracker.setDismissed("p1", second, false);
      changes = await tracker.sessionChanges("p1", "Worker");
      expect(paths(changes.section)).toEqual(["a.ts", "b.ts"]);
      expect(changes.section?.summaries.map((s) => s.text)).toEqual(["Adds b.", "Adds a."]);
      expect(changes.cleared).toEqual([]);
      // A full diff's seq, cleared by an older client, does not touch the panel.
      tracker.setDismissed("p1", 32, true);
      expect((await tracker.sessionChanges("p1", "Worker")).cleared).toEqual([]);
    });

    it("never shows what a cleared turn between shown ones did", async () => {
      const { db, tracker } = setup();
      const app = repo("app");
      const write = (name: string, text: string) => () => writeFileSync(join(app.dir, name), text);
      await turn(db, tracker, "p2", 10, app.dir, write("a.ts", "export const a = 1;\n"));
      const middle = await turn(
        db,
        tracker,
        "p2",
        20,
        app.dir,
        () => {
          writeFileSync(join(app.dir, "secret.ts"), "export const s = 1;\n");
          writeFileSync(join(app.dir, "a.ts"), "export const a = 1;\nexport const more = 2;\n");
        },
        undefined,
        [{ path: "a.ts", explanation: "Adds more." }],
      );
      await turn(db, tracker, "p2", 30, app.dir, write("c.ts", "export const c = 3;\n"));
      tracker.setDismissed("p2", middle, true);
      const { section } = await tracker.sessionChanges("p2", "Worker");
      expect(paths(section)).toEqual(["a.ts", "c.ts"]);
      // a.ts as the first turn left it: the cleared turn's line is not in its diff.
      // Nor the cleared turn's explanation of it.
      expect(section?.repos[0]?.files.find((f) => f.path === "a.ts")).toMatchObject({ status: "added", additions: 1, note: null });
      expect(await tracker.file("p2", app.dir, "secret.ts")).toBe(null);
      const diff = await tracker.file("p2", app.dir, "a.ts");
      expect(diff?.symbols.flatMap((s) => s.hunks.flatMap((h) => h.lines.map((l) => l.text)))).not.toContain("export const more = 2;");
      expect(diff?.note).toBe(null);
      // Brought back, its explanation is too.
      tracker.setDismissed("p2", middle, false);
      expect((await tracker.sessionChanges("p2", "Worker")).section?.repos[0]?.files.find((f) => f.path === "a.ts")?.note).toBe("Adds more.");
    });
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

      // Without commits, in either object format: the repository's own empty tree.
      for (const format of ["sha1", "sha256"]) {
        const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "apollo-empty-"))), "empty");
        mkdirSync(dir);
        execFileSync("git", ["init", "-q", `--object-format=${format}`], { cwd: dir });
        writeFileSync(join(dir, "first.ts"), "export const first = 1;\n");
        const empty = await tracker.report(dir);
        const emptyTree = execFileSync("git", ["hash-object", "-t", "tree", "/dev/null"], { cwd: dir, encoding: "utf8" }).trim();
        expect(emptyTree).toHaveLength(format === "sha1" ? 40 : 64);
        expect(empty.report.base).toMatchObject({ ref: "(no commits)", commit: null, tree: emptyTree });
        expect(empty.repo.files.map((f) => [f.path, f.status])).toEqual([["first.ts", "added"]]);
      }
      await expect(tracker.report(tmpdir())).rejects.toThrow("is not in a git repository");
    }, GIT_HEAVY);

    it("never compares against a history HEAD does not share", async () => {
      const { tracker } = setup();
      const work = cloned();
      // An orphan branch: no common ancestor with origin/main or with HEAD.
      work.git("checkout", "-q", "--orphan", "other");
      work.git("rm", "-rqf", ".");
      writeFileSync(join(work.dir, "other.ts"), "export const other = 1;\n");
      work.git("add", "-A");
      work.git("commit", "-qm", "other");
      work.git("checkout", "-q", "main");
      await expect(tracker.report(work.dir, "other")).rejects.toThrow('"other" shares no history with HEAD');
      // By default, an unrelated origin is skipped rather than diffed: HEAD itself, said so.
      work.git("checkout", "-q", "other");
      const { repo: changes, report } = await tracker.report(work.dir);
      expect(report.base.ref).not.toMatch(/origin/);
      expect([report.commitCount, changes.files.length]).toEqual([0, 0]);
    }, GIT_HEAVY);

    it("bounds what it stores, and counts lines over every changed file", async () => {
      const { tracker } = setup();
      const work = cloned();
      writeFileSync(join(work.dir, "message.txt"), `${"x".repeat(2 * 1024 * 1024)}\n`);
      work.git("commit", "-q", "--allow-empty", "-F", "message.txt");
      rmSync(join(work.dir, "message.txt"));
      for (let i = 0; i < MAX_REPORT_FILES + 11; i++) writeFileSync(join(work.dir, `f${i}.ts`), "export {};\n");
      await expect(tracker.report(work.dir, "--x")).rejects.toThrow("is not a git ref");
      await expect(tracker.report(work.dir, "a".repeat(MAX_REF_LENGTH + 1))).rejects.toThrow("is not a git ref");
      const { repo: changes, report } = await tracker.report(work.dir);
      expect(report.commits[0]!.subject.length).toBe(MAX_SUBJECT_LENGTH);
      expect([changes.files.length, report.moreFiles]).toEqual([MAX_REPORT_FILES, 11]);
      expect([report.additions, report.deletions]).toEqual([MAX_REPORT_FILES + 11, 0]);
      expect(JSON.stringify(report).length).toBeLessThan(20_000);
    }, GIT_HEAVY);

    /** Puts a `git` in front of the real one for the rest of the test; `script` runs before each call. */
    const shimGit = (script: string) => {
      const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const bin = realpathSync(mkdtempSync(join(tmpdir(), "apollo-git-shim-")));
      writeFileSync(join(bin, "git"), `#!/bin/sh\nREAL_GIT="${real}"\n${script}\nexec "$REAL_GIT" "$@"\n`, { mode: 0o755 });
      const path = process.env.PATH;
      process.env.PATH = `${bin}:${path}`;
      return { bin, restore: () => void (process.env.PATH = path) };
    };

    it("describes one state of the repository when a commit lands while it reads", async () => {
      const { tracker } = setup();
      const work = cloned();
      writeFileSync(join(work.dir, "moved.ts"), "export const moved = 1;\n");
      work.git("add", "moved.ts");
      // The first snapshot's `git add` commits the staged file first, through the real index.
      const shim = shimGit(
        `if [ "$1" = "add" ] && [ -n "$GIT_INDEX_FILE" ] && [ ! -e "$SHIM_DIR/done" ]; then touch "$SHIM_DIR/done"; env -u GIT_INDEX_FILE "$REAL_GIT" -c user.email=t@t -c user.name=t commit -qm moved; fi`,
      );
      process.env.SHIM_DIR = shim.bin;
      try {
        const { repo: changes, report } = await tracker.report(work.dir);
        const head = work.git("rev-parse", "HEAD").trim();
        expect(report.head.commit).toBe(head);
        expect([report.commitCount, report.commits.map((c) => c.subject)]).toEqual([1, ["moved"]]);
        expect(report.uncommitted).toBe(false);
        expect(changes.files.map((f) => f.path)).toEqual(["moved.ts"]);
        expect(work.git("status", "--porcelain")).toBe("");
      } finally {
        shim.restore();
        delete process.env.SHIM_DIR;
      }
    }, GIT_HEAVY);

    it("starts nothing once aborted, not even looking for the repository", async () => {
      const { tracker } = setup();
      const work = cloned();
      const shim = shimGit(`echo "$1" >> "$SHIM_DIR/calls"`);
      process.env.SHIM_DIR = shim.bin;
      try {
        await expect(tracker.report(work.dir, undefined, AbortSignal.abort(new Error("Stopped early")))).rejects.toThrow("Stopped early");
        expect(existsSync(join(shim.bin, "calls"))).toBe(false);
      } finally {
        shim.restore();
        delete process.env.SHIM_DIR;
      }
    }, GIT_HEAVY);

    it("kills what git started (a clean filter) when aborted", async () => {
      const { tracker } = setup();
      const work = cloned();
      const marks = realpathSync(mkdtempSync(join(tmpdir(), "apollo-filter-")));
      // A slow clean filter: says it started, then finishes after 1.5 s unless killed.
      writeFileSync(
        join(marks, "clean.cjs"),
        `const fs = require("fs");
fs.writeFileSync(${JSON.stringify(join(marks, "started"))}, String(process.pid));
let data = "";
process.stdin.on("data", (d) => (data += d));
process.stdin.on("end", () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(join(marks, "finished"))}, "done"); process.stdout.write(data); }, 1500));`,
      );
      writeFileSync(join(work.dir, ".gitattributes"), "*.txt filter=slow\n");
      work.git("config", "filter.slow.clean", `"${process.execPath}" "${join(marks, "clean.cjs")}"`);
      work.git("config", "filter.slow.required", "true");
      writeFileSync(join(work.dir, "a.txt"), "text\n");
      const controller = new AbortController();
      const running = tracker.report(work.dir, undefined, controller.signal);
      while (!existsSync(join(marks, "started"))) await new Promise((resolve) => setTimeout(resolve, 10));
      const pid = Number(readFileSync(join(marks, "started"), "utf8"));
      controller.abort(new Error("Stopped"));
      await expect(running).rejects.toThrow("Stopped");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(existsSync(join(marks, "finished"))).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
    }, GIT_HEAVY);

    it("stops, git processes included, when its signal is aborted", async () => {
      const { tracker } = setup();
      const work = cloned();
      writeFileSync(join(work.dir, "new.ts"), "export {};\n");
      await expect(tracker.report(work.dir, undefined, AbortSignal.abort(new Error("Stopped early")))).rejects.toThrow("Stopped early");

      // Every git call is logged; the snapshot's `add` takes two seconds.
      const shim = shimGit(`echo "$1" >> "$SHIM_DIR/calls"; if [ "$1" = "add" ]; then touch "$SHIM_DIR/adding"; sleep 3; fi`);
      process.env.SHIM_DIR = shim.bin;
      try {
        const controller = new AbortController();
        const running = tracker.report(work.dir, undefined, controller.signal);
        // Abort once the snapshot's `add` is under way.
        while (!existsSync(join(shim.bin, "adding"))) await new Promise((resolve) => setTimeout(resolve, 20));
        const aborted = Date.now();
        controller.abort(new Error("Timed out"));
        await expect(running).rejects.toThrow("Timed out");
        // The three-second `add` was killed, not waited for.
        expect(Date.now() - aborted).toBeLessThan(2000);
        // Nothing runs after the abort: no tree is written, no diff is taken.
        await new Promise((resolve) => setTimeout(resolve, 3500));
        const calls = readFileSync(join(shim.bin, "calls"), "utf8").split("\n");
        expect(calls).toContain("add");
        expect(calls.filter((c) => c === "write-tree" || c === "diff" || c === "--git-dir")).toEqual([]);
      } finally {
        shim.restore();
        delete process.env.SHIM_DIR;
      }
    }, GIT_HEAVY);
  });

  it("reads the index's entries and its time from one version, even when git replaces it meanwhile", async () => {
    // Same pinned setup as below; then `git add` replaces the index right after the snapshot
    // opens it. The entries copied and the time kept must both be the old index's.
    const app = repo("app");
    app.git("config", "core.trustctime", "false");
    const file = join(app.dir, "value.ts");
    writeFileSync(file, "export const value = 1;\n");
    app.git("add", "-A");
    app.git("commit", "-qm", "value");
    const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    utimesSync(file, past, past);
    app.git("update-index", "--refresh");
    const realIndex = join(app.dir, ".git", "index");
    utimesSync(realIndex, past, past);
    writeFileSync(file, "export const value = 2;\n");
    utimesSync(file, past, past);
    const original = fs.openSync;
    let injected = false;
    fs.openSync = ((path: fs.PathLike, ...rest: Array<never>) => {
      const fd = (original as (...args: Array<unknown>) => number)(path, ...rest);
      if (String(path) === realIndex && !injected) {
        injected = true;
        app.git("add", "value.ts");
      }
      return fd;
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try {
      const tree = await snapshot(app.dir);
      expect(injected).toBe(true);
      expect(app.git("cat-file", "blob", `${tree}:value.ts`)).toBe("export const value = 2;\n");
    } finally {
      fs.openSync = original;
      syncBuiltinESMExports();
    }
  });

  it("sees an edit that leaves a file's size and time as the index recorded them (racily clean)", async () => {
    // git rehashes an entry as new as the index file itself ("racily clean"), since its stat
    // cannot tell an edit made in that same instant. A copy of the index stamped later hid
    // such an edit. Here the timestamps are pinned so only that rule can reveal the edit.
    const app = repo("app");
    app.git("config", "core.trustctime", "false");
    const file = join(app.dir, "value.ts");
    writeFileSync(file, "export const value = 0;\n");
    app.git("add", "-A");
    app.git("commit", "-qm", "value");
    const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    utimesSync(file, past, past);
    app.git("update-index", "--refresh");
    utimesSync(join(app.dir, ".git", "index"), past, past);
    writeFileSync(file, "export const value = 2;\n");
    utimesSync(file, past, past);
    const tree = await snapshot(app.dir);
    expect(app.git("cat-file", "blob", `${tree}:value.ts`)).toBe("export const value = 2;\n");
  });
});
