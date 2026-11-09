import childProcess, { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

  describe("only what the session's own work changed", () => {
    /** Commits made before a turn must be older than its start (commit times are in seconds). */
    const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));
    const commit = (git: (...args: Array<string>) => string, message: string) => {
      git("add", "-A");
      git("commit", "-qm", message);
    };
    const paths = async (tracker: ReturnType<typeof setup>["tracker"], sessionId: string) =>
      ((await tracker.sessionChanges(sessionId, "W")).section?.repos ?? []).map((r) => [r.name, r.files.map((f) => [f.path, f.status])]);

    it(
      "leaves out what moving HEAD onto existing commits brought in: a clone, a checkout, a pull, a merge",
      async () => {
        const { tracker } = setup();
        const app = repo("app");
        app.git("branch", "-M", "main");
        app.git("checkout", "-qb", "feature");
        for (const name of ["x", "y", "z"]) writeFileSync(join(app.dir, `${name}.ts`), `export const ${name} = 1;\n`);
        commit(app.git, "feature");
        app.git("checkout", "-q", "main");
        await nextSecond();

        // A review in its turn: clones (seen before its checkout fills it), checks out the
        // feature, probes one file. Only the probe is its work, against what it checked out.
        const home = realpathSync(mkdtempSync(join(tmpdir(), "apollo-home-")));
        await tracker.turnStarted("r", 1, home);
        const clone = join(home, "review");
        execFileSync("git", ["clone", "-q", "--no-checkout", app.dir, clone]);
        await tracker.toolStarted("r", `cd ${clone} && git checkout feature`);
        execFileSync("git", ["checkout", "-q", "feature"], { cwd: clone });
        writeFileSync(join(clone, "x.ts"), "export const x = 'probe';\n");
        writeFileSync(join(clone, "probe.test.ts"), "// probe\n");
        const review = await tracker.turnCompleted("r");
        expect(review?.repos.map((r) => r.files.map((f) => [f.path, f.status]))).toEqual([
          [
            ["probe.test.ts", "added"],
            ["x.ts", "modified"],
          ],
        ]);

        // A worker commits its own change, then checks out and merges others' existing work:
        // its commit is its work, the merge's other side is not.
        await tracker.turnStarted("w", 1, app.dir);
        writeFileSync(join(app.dir, "store.ts"), "export class Store {}\n");
        commit(app.git, "mine");
        app.git("merge", "-q", "--no-edit", "feature");
        app.git("checkout", "-q", "feature");
        app.git("checkout", "-q", "main");
        await tracker.turnCompleted("w");
        expect(await paths(tracker, "w")).toEqual([["app", [["store.ts", "modified"]]]]);
      },
      GIT_HEAVY,
    );

    it(
      "keeps what a commit made in the turn changed, even through a merge it resolved",
      async () => {
        const { tracker } = setup();
        const app = repo("app");
        app.git("branch", "-M", "main");
        app.git("checkout", "-qb", "side");
        writeFileSync(join(app.dir, "store.ts"), "export class Store { side = 1 }\n");
        commit(app.git, "side");
        app.git("checkout", "-q", "main");
        await nextSecond();
        await tracker.turnStarted("m", 1, app.dir);
        writeFileSync(join(app.dir, "store.ts"), "export class Store { main = 1 }\n");
        commit(app.git, "main");
        expect(() => app.git("merge", "-q", "side")).toThrow(); // a conflict
        writeFileSync(join(app.dir, "store.ts"), "export class Store { both = 1 }\n");
        app.git("add", "-A");
        app.git("commit", "-q", "--no-edit");
        await tracker.turnCompleted("m");
        expect(await paths(tracker, "m")).toEqual([["app", [["store.ts", "modified"]]]]);
      },
      GIT_HEAVY,
    );

    it("leaves out what changed between its turns, and a file it changed back across them", async () => {
      const { tracker } = setup();
      const app = repo("app");
      await tracker.turnStarted("g", 1, app.dir);
      writeFileSync(join(app.dir, "a.ts"), "export const a = 1;\n");
      writeFileSync(join(app.dir, "store.ts"), "export class Store {}\n");
      await tracker.turnCompleted("g");
      // Someone else, between the turns.
      writeFileSync(join(app.dir, "theirs.ts"), "export const theirs = 1;\n");
      await tracker.turnStarted("g", 2, app.dir);
      writeFileSync(join(app.dir, "b.ts"), "export const b = 2;\n");
      app.git("checkout", "--", "store.ts"); // its own change, undone
      await tracker.turnCompleted("g");
      expect(await paths(tracker, "g")).toEqual([
        [
          "app",
          [
            ["a.ts", "added"],
            ["b.ts", "added"],
          ],
        ],
      ]);
      expect(await tracker.file("g", app.dir, "theirs.ts")).toBe(null);
      expect(await tracker.file("g", app.dir, "store.ts")).toBe(null);
    });

    it(
      "never filters what the turn's own commits changed: a conflict resolved to one side, an older tree, any path",
      async () => {
        const BASE = "export const value = 0;\nexport const stable = 10;\n";
        const one = BASE.replace("= 0", "= 1");
        const lines = async (tracker: ReturnType<typeof setup>["tracker"], sessionId: string, dir: string, path: string) =>
          ((await tracker.file(sessionId, dir, path))?.symbols ?? []).flatMap((s) => s.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "ctx").map((l) => `${l.kind} ${l.text}`)));

        // A conflict resolved by taking the incoming side whole: the merge equals one parent.
        const { tracker } = setup();
        const app = repo("app");
        app.git("branch", "-M", "main");
        writeFileSync(join(app.dir, "a.ts"), BASE);
        commit(app.git, "base");
        app.git("checkout", "-qb", "side");
        writeFileSync(join(app.dir, "a.ts"), BASE.replace("= 0", "= 2"));
        commit(app.git, "side");
        app.git("checkout", "-q", "main");
        writeFileSync(join(app.dir, "a.ts"), one);
        commit(app.git, "main");
        // A file whose name starts with a space, and a commit whose tree an older commit had.
        writeFileSync(join(app.dir, " lead.ts"), BASE);
        writeFileSync(join(app.dir, "b.ts"), one);
        commit(app.git, "older one");
        writeFileSync(join(app.dir, "b.ts"), BASE);
        commit(app.git, "back to zero");
        await nextSecond();
        await tracker.turnStarted("c", 1, app.dir);
        expect(() => app.git("merge", "-q", "side")).toThrow();
        app.git("checkout", "--theirs", "a.ts");
        commit(app.git, "resolve, theirs");
        writeFileSync(join(app.dir, " lead.ts"), one);
        writeFileSync(join(app.dir, "b.ts"), one);
        commit(app.git, "mine");
        await tracker.turnCompleted("c");
        expect(await paths(tracker, "c")).toEqual([
          [
            "app",
            [
              [" lead.ts", "modified"],
              ["a.ts", "modified"],
              ["b.ts", "modified"],
            ],
          ],
        ]);
        expect(await lines(tracker, "c", app.dir, "a.ts")).toEqual(["del export const value = 1;", "add export const value = 2;"]);
      },
      GIT_HEAVY,
    );

    it(
      "measures a resolution in a file the other side renamed from the source's content",
      async () => {
        const { tracker } = setup();
        const app = repo("app");
        app.git("branch", "-M", "main");
        const body = (value: number) =>
          `export const value = ${value};\n${Array.from({ length: 20 }, (_, n) => `export const stable${n} = ${n};\n`).join("")}`;
        writeFileSync(join(app.dir, "a.ts"), body(0));
        commit(app.git, "base");
        app.git("checkout", "-qb", "side");
        app.git("mv", "a.ts", "b.ts");
        writeFileSync(join(app.dir, "b.ts"), body(2));
        commit(app.git, "side renames");
        app.git("checkout", "-q", "main");
        writeFileSync(join(app.dir, "a.ts"), body(1));
        commit(app.git, "main");
        await nextSecond();
        await tracker.turnStarted("rn", 1, app.dir);
        expect(() => app.git("merge", "-q", "side")).toThrow();
        rmSync(join(app.dir, "a.ts"), { force: true });
        writeFileSync(join(app.dir, "b.ts"), body(3));
        commit(app.git, "resolved");
        const done = await tracker.turnCompleted("rn");
        // Only the resolved line is the turn's; the move itself came with the other side.
        expect(done?.repos.map((r) => r.files.map((f) => [f.path, f.status, f.additions, f.deletions]))).toEqual([[["b.ts", "modified", 1, 1]]]);
        const diff = await tracker.file("rn", app.dir, "b.ts");
        expect(diff?.symbols.map((s) => [s.name, s.change, s.additions, s.deletions])).toEqual([["value", "modified", 1, 1]]);
      },
      GIT_HEAVY,
    );

    it(
      "measures a repository the turn cloned from what it checked out, committed edits included",
      async () => {
        const { tracker } = setup();
        const app = repo("app");
        app.git("branch", "-M", "main");
        await nextSecond();
        const home = realpathSync(mkdtempSync(join(tmpdir(), "apollo-home-")));
        await tracker.turnStarted("k", 1, home);
        const clone = join(home, "clone");
        execFileSync("git", ["clone", "-q", "--no-checkout", app.dir, clone]);
        await tracker.toolStarted("k", `cd ${clone} && git checkout main`);
        const git = (...args: Array<string>) => execFileSync("git", args, { cwd: clone, encoding: "utf8" });
        git("config", "user.email", "test@example.com");
        git("config", "user.name", "Test");
        git("checkout", "-q", "main");
        writeFileSync(join(clone, "store.ts"), "export class Store {\n  list() {\n    return ['a'];\n  }\n}\n");
        writeFileSync(join(clone, "new.ts"), "export const fresh = 1;\n");
        commit(git, "own edit");
        const done = await tracker.turnCompleted("k");
        expect(done?.repos.map((r) => r.files.map((f) => [f.path, f.status, f.additions, f.deletions]))).toEqual([
          [
            ["new.ts", "added", 1, 0],
            ["store.ts", "modified", 1, 1],
          ],
        ]);
        const diff = await tracker.file("k", clone, "store.ts");
        expect(diff?.symbols.map((s) => [s.name, s.change, s.additions, s.deletions])).toEqual([["Store.list", "modified", 1, 1]]);
      },
      GIT_HEAVY,
    );

    it("says what changed in a listed file without a changed line", async () => {
      const { tracker } = setup();
      const app = repo("app");
      await tracker.turnStarted("x", 1, app.dir);
      fs.chmodSync(join(app.dir, "store.ts"), 0o755);
      await tracker.turnCompleted("x");
      expect(await tracker.file("x", app.dir, "store.ts")).toMatchObject({
        symbols: [],
        omitted: "Only its file mode changed (100644 → 100755); no line changed",
      });
    });
  });

  describe("turns cleared from the Changes panel", () => {
    type Setup = ReturnType<typeof setup>;
    /**
     * Runs a turn as SessionManager does: TurnStarted at `seq`, then (if it changed files and
     * `noEvent` is not set, as when storing it timed out) its FilesChanged event at `seq + 5`.
     */
    const turn = async (
      { db, tracker }: Setup,
      sessionId: string,
      seq: number,
      dir: string,
      work: () => void,
      options: { summary?: string; notes?: ReadonlyArray<{ path: string; explanation: string }>; noEvent?: boolean } = {},
    ) => {
      const event = db.prepare("insert into session_events (session_id, seq, at, event) values (?, ?, ?, ?)");
      event.run(sessionId, seq, seq, JSON.stringify({ _tag: "TurnStarted" }));
      await tracker.turnStarted(sessionId, seq, dir);
      work();
      const notes = options.notes ?? [];
      if (options.summary || notes.length) await tracker.explain(sessionId, options.summary ?? "", notes);
      const done = await tracker.turnCompleted(sessionId);
      if (done?.repos.length && !options.noEvent) {
        event.run(sessionId, seq + 5, seq + 5, JSON.stringify({ _tag: "FilesChanged", repos: done.repos }));
        return seq + 5;
      }
      return null;
    };
    const paths = (section: { repos: ReadonlyArray<{ files: ReadonlyArray<{ path: string }> }> } | null) =>
      section?.repos.flatMap((r) => r.files.map((f) => f.path)) ?? null;
    const write = (dir: string, name: string, text: string) => () => writeFileSync(join(dir, name), text);

    it("leaves cleared turns' files and summaries out, lists them, and brings them back", async () => {
      const t = setup();
      const { db, tracker } = t;
      const app = repo("app");
      const first = await turn(t, "p1", 10, app.dir, write(app.dir, "a.ts", "export const a = 1;\n"), { summary: "Adds a." });
      await turn(
        t,
        "p1",
        30,
        app.dir,
        () => {
          writeFileSync(join(app.dir, "b.ts"), "export const b = 2;\n");
          // A full diff the user asked for during the turn (it carries a report): not the turn's changes.
          db.prepare("insert into session_events (session_id, seq, at, event) values (?, ?, ?, ?)").run(
            "p1",
            32,
            32,
            JSON.stringify({ _tag: "FilesChanged", repos: [], report: {} }),
          );
        },
        { summary: "Adds b." },
      );
      expect(first).toBe(15);
      let changes = await tracker.sessionChanges("p1", "Worker");
      expect(paths(changes.section)).toEqual(["a.ts", "b.ts"]);
      // The panel clears turns by their TurnStarted seq.
      expect(changes.section?.turns).toEqual([10, 30]);
      expect(changes.cleared).toEqual([]);

      tracker.setDismissed("p1", 10, true);
      changes = await tracker.sessionChanges("p1", "Worker");
      expect(paths(changes.section)).toEqual(["b.ts"]);
      expect(changes.section?.summaries.map((s) => s.text)).toEqual(["Adds b."]);
      expect(changes.section?.turns).toEqual([30]);
      expect(changes.cleared).toEqual([10]);
      expect(await tracker.file("p1", app.dir, "a.ts")).toBe(null);
      expect((await tracker.file("p1", app.dir, "b.ts"))?.status).toBe("added");

      tracker.setDismissed("p1", 30, true);
      expect(await tracker.sessionChanges("p1", "Worker")).toEqual({ section: null, cleared: [10, 30] });

      tracker.setDismissed("p1", 10, false);
      tracker.setDismissed("p1", 30, false);
      changes = await tracker.sessionChanges("p1", "Worker");
      expect(paths(changes.section)).toEqual(["a.ts", "b.ts"]);
      expect(changes.section?.summaries.map((s) => s.text)).toEqual(["Adds b.", "Adds a."]);
      expect(changes.cleared).toEqual([]);

      // An older client clears the first turn's card (its FilesChanged seq): the turn is cleared,
      // offered back by that seq; brought back by its TurnStarted seq, both clears go.
      tracker.setDismissed("p1", first!, true);
      changes = await tracker.sessionChanges("p1", "Worker");
      expect([paths(changes.section), changes.cleared]).toEqual([["b.ts"], [first]]);
      tracker.setDismissed("p1", 10, true);
      expect((await tracker.sessionChanges("p1", "Worker")).cleared).toEqual([10]);
      tracker.setDismissed("p1", 10, false);
      changes = await tracker.sessionChanges("p1", "Worker");
      expect([paths(changes.section), changes.cleared, tracker.conversation("p1").dismissed]).toEqual([["a.ts", "b.ts"], [], []]);
      // A full diff's seq, cleared by an older client, does not touch the panel.
      tracker.setDismissed("p1", 32, true);
      expect((await tracker.sessionChanges("p1", "Worker")).cleared).toEqual([]);
    });

    it("lets every section be cleared to nothing, whatever its turns left: files, a summary only, no event", async () => {
      const t = setup();
      const { tracker } = t;
      const app = repo("app");
      await turn(t, "p3", 10, app.dir, write(app.dir, "a.ts", "export const a = 1;\n"));
      // A turn that changed no file but explained itself, and one whose FilesChanged was never stored.
      await turn(t, "p3", 20, app.dir, () => {}, { summary: "Only looked around." });
      await turn(t, "p3", 30, app.dir, write(app.dir, "late.ts", "export const late = 1;\n"), { noEvent: true, summary: "Late." });
      const all = [10, 20, 30];
      expect((await tracker.sessionChanges("p3", "Worker")).section?.turns).toEqual(all);
      // Under every combination of clears: a section shown always has turns to clear, and
      // clearing them leaves nothing of it.
      for (let mask = 0; mask < 1 << all.length; mask++) {
        all.forEach((seq, i) => tracker.setDismissed("p3", seq, (mask & (1 << i)) !== 0));
        const { section, cleared } = await tracker.sessionChanges("p3", "Worker");
        expect(cleared).toEqual(all.filter((_, i) => mask & (1 << i)));
        if (section === null) {
          expect(cleared).toEqual(all);
          continue;
        }
        expect(section.turns?.length).toBeGreaterThan(0);
        for (const seq of section.turns!) tracker.setDismissed("p3", seq, true);
        expect((await tracker.sessionChanges("p3", "Worker")).section).toBe(null);
      }
    });

    it("never shows the entries of a cleared turn between shown ones", async () => {
      const t = setup();
      const { tracker } = t;
      const app = repo("app");
      await turn(t, "p2", 10, app.dir, write(app.dir, "a.ts", "export const a = 1;\n"));
      await turn(
        t,
        "p2",
        20,
        app.dir,
        () => {
          writeFileSync(join(app.dir, "secret.ts"), "export const s = 1;\n");
          writeFileSync(join(app.dir, "a.ts"), "export const a = 1;\nexport const more = 2;\n");
        },
        { notes: [{ path: "a.ts", explanation: "Adds more." }] },
      );
      await turn(t, "p2", 30, app.dir, write(app.dir, "c.ts", "export const c = 3;\n"));
      tracker.setDismissed("p2", 20, true);
      const { section } = await tracker.sessionChanges("p2", "Worker");
      expect(paths(section)).toEqual(["a.ts", "c.ts"]);
      // a.ts as the first turn left it, without the cleared turn's explanation of it.
      expect(section?.repos[0]?.files.find((f) => f.path === "a.ts")).toMatchObject({ status: "added", additions: 1, note: null });
      expect(await tracker.file("p2", app.dir, "secret.ts")).toBe(null);
      const diff = await tracker.file("p2", app.dir, "a.ts");
      expect(diff?.symbols.flatMap((s) => s.hunks.flatMap((h) => h.lines.map((l) => l.text)))).not.toContain("export const more = 2;");
      expect(diff?.note).toBe(null);
      tracker.setDismissed("p2", 20, false);
      expect((await tracker.sessionChanges("p2", "Worker")).section?.repos[0]?.files.find((f) => f.path === "a.ts")?.note).toBe("Adds more.");
    });

    it("leaves out only shown work that cancels itself, never a later turn's undoing of a cleared turn or of others' work", async () => {
      const t = setup();
      const { tracker } = t;
      const app = repo("app");
      const BASE = "export const value = 0;\nexport const stable = 10;\n";
      writeFileSync(join(app.dir, "a.ts"), BASE);
      writeFileSync(join(app.dir, "b.ts"), BASE);
      writeFileSync(join(app.dir, "c.ts"), BASE);
      app.git("add", "-A");
      app.git("commit", "-qm", "base");
      const changed = (diff: Awaited<ReturnType<typeof tracker.file>>) =>
        diff?.symbols.flatMap((s) => s.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "ctx").map((l) => `${l.kind} ${l.text}`))) ?? null;
      // a.ts: shown, cleared, shown. b.ts: shown, then changed back after a gap on another file. c.ts: shown, someone else, shown.
      await turn(t, "n", 10, app.dir, () => {
        writeFileSync(join(app.dir, "a.ts"), BASE.replace("value = 0", "value = 1"));
        writeFileSync(join(app.dir, "b.ts"), BASE.replace("value = 0", "value = 1"));
        writeFileSync(join(app.dir, "c.ts"), BASE.replace("value = 0", "value = 1"));
      });
      await turn(t, "n", 20, app.dir, write(app.dir, "a.ts", BASE.replace("value = 0", "value = 1").replace("stable = 10", "stable = 20")));
      writeFileSync(join(app.dir, "c.ts"), BASE.replace("value = 0", "value = 1").replace("stable = 10", "stable = 30"));
      writeFileSync(join(app.dir, "other.ts"), "export const other = 1;\n");
      await turn(t, "n", 30, app.dir, () => {
        for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(app.dir, name), BASE);
      });
      tracker.setDismissed("n", 20, true);
      const { section } = await tracker.sessionChanges("n", "Worker");
      // b.ts cancels; a.ts and c.ts end as they began, but the last turn undid someone's line.
      expect(paths(section)).toEqual(["a.ts", "c.ts"]);
      expect(changed(await tracker.file("n", app.dir, "a.ts"))).toEqual([
        "del export const value = 1;",
        "add export const value = 0;",
        "del export const stable = 20;",
        "add export const stable = 10;",
      ]);
      expect(changed(await tracker.file("n", app.dir, "c.ts"))).toContain("del export const stable = 30;");
      expect(await tracker.file("n", app.dir, "b.ts")).toBe(null);
      // Brought back, the cleared turn joins its neighbours: a.ts's shown work and its own cancel out.
      tracker.setDismissed("n", 20, false);
      expect(paths((await tracker.sessionChanges("n", "Worker")).section)).toEqual(["c.ts"]);
    });

    it(
      "follows each file by identity across a cleared turn: renames, deletions, recreations",
      async () => {
        const STORE = "export class Store {\n  list() {\n    return [];\n  }\n}\n";
        const V = "export const visible = 1;\nexport const kept = 2;\nexport const also = 3;\n";
        const cases: Array<{
          name: string;
          before: (dir: string) => void;
          after: (dir: string) => void;
          files: Array<[string, string, string | null]>;
          gone: Array<string>;
        }> = [
          {
            name: "added, then renamed",
            before: (d) => writeFileSync(join(d, "visible.ts"), V),
            after: (d) => renameSync(join(d, "visible.ts"), join(d, "renamed.ts")),
            files: [["renamed.ts", "added", null]],
            gone: ["visible.ts"],
          },
          {
            name: "modified, then renamed",
            before: (d) => writeFileSync(join(d, "store.ts"), STORE.replace("[]", "[1]")),
            after: (d) => renameSync(join(d, "store.ts"), join(d, "repo.ts")),
            files: [["repo.ts", "renamed", "store.ts"]],
            gone: ["store.ts"],
          },
          {
            name: "renamed, then renamed again",
            before: (d) => renameSync(join(d, "store.ts"), join(d, "a.ts")),
            after: (d) => renameSync(join(d, "a.ts"), join(d, "b.ts")),
            files: [["b.ts", "renamed", "store.ts"]],
            gone: ["a.ts", "store.ts"],
          },
          {
            name: "added, then deleted",
            before: (d) => writeFileSync(join(d, "visible.ts"), V),
            after: (d) => rmSync(join(d, "visible.ts")),
            files: [],
            gone: ["visible.ts"],
          },
          {
            name: "renamed, then deleted",
            before: (d) => renameSync(join(d, "store.ts"), join(d, "a.ts")),
            after: (d) => rmSync(join(d, "a.ts")),
            files: [["store.ts", "deleted", null]],
            gone: ["a.ts"],
          },
          {
            name: "deleted, then recreated",
            before: (d) => rmSync(join(d, "store.ts")),
            after: (d) => writeFileSync(join(d, "store.ts"), "export const store = 1;\n"),
            files: [["store.ts", "modified", null]],
            gone: [],
          },
          {
            name: "added, then modified",
            before: (d) => writeFileSync(join(d, "visible.ts"), V),
            after: (d) => writeFileSync(join(d, "visible.ts"), V.replace("1", "10")),
            files: [["visible.ts", "added", null]],
            gone: [],
          },
        ];
        for (const [i, c] of cases.entries()) {
          const t = setup();
          const app = repo("app");
          const id = `r${i}`;
          await turn(t, id, 10, app.dir, () => c.before(app.dir));
          await turn(t, id, 20, app.dir, write(app.dir, "other.ts", "export const other = 1;\n"));
          await turn(t, id, 30, app.dir, () => c.after(app.dir));
          t.tracker.setDismissed(id, 20, true);
          const { section } = await t.tracker.sessionChanges(id, "Worker");
          const files = section?.repos.flatMap((r) => r.files.map((f): [string, string, string | null] => [f.path, f.status, f.oldPath])) ?? [];
          expect([c.name, files]).toEqual([c.name, c.files]);
          for (const path of c.gone) expect([c.name, path, await t.tracker.file(id, app.dir, path)]).toEqual([c.name, path, null]);
          for (const [path] of c.files) expect([c.name, path, (await t.tracker.file(id, app.dir, path)) !== null]).toEqual([c.name, path, true]);
        }
      },
      GIT_HEAVY,
    );

    it(
      "keeps each file's history off a path another file took over (path reuse), with or without clears between",
      async () => {
        const REPLACEMENT = "export const replacement = 88;";
        const renameAway = (d: string) => renameSync(join(d, "store.ts"), join(d, "z.ts"));
        const recreate = (d: string) => writeFileSync(join(d, "store.ts"), `${REPLACEMENT}\n`);
        const remove = (name: string) => (d: string) => rmSync(join(d, name));
        const all =
          (...steps: Array<(d: string) => void>) =>
          (d: string) =>
            steps.forEach((step) => step(d));
        /** Turns in order; "gap" is a turn (changing another file) that the user cleared. */
        const cases: Array<{
          name: string;
          turns: Array<((d: string) => void) | "gap">;
          files: Array<[string, string, string | null]>;
          gone: Array<string>;
          /** The path whose diff must be the replacement's own (no deletion served in its place). */
          replacement?: "only" | "within";
        }> = [
          {
            name: "renamed away · gap · recreated · gap · renamed one deleted",
            turns: [renameAway, "gap", recreate, "gap", remove("z.ts")],
            files: [["store.ts", "modified", null]],
            gone: ["z.ts"],
            replacement: "only",
          },
          {
            name: "renamed away · gap · recreated and renamed one deleted",
            turns: [renameAway, "gap", all(recreate, remove("z.ts"))],
            files: [["store.ts", "modified", null]],
            gone: ["z.ts"],
            replacement: "only",
          },
          {
            name: "renamed away, recreated, renamed one deleted: no clear",
            turns: [all(renameAway, recreate, remove("z.ts"))],
            files: [["store.ts", "modified", null]],
            gone: ["z.ts"],
            replacement: "within",
          },
          {
            name: "renamed away · gap · recreated",
            turns: [renameAway, "gap", recreate],
            files: [
              ["store.ts", "added", null],
              ["z.ts", "renamed", "store.ts"],
            ],
            gone: [],
            replacement: "only",
          },
          {
            name: "renamed away · gap · recreated · gap · the new one deleted",
            turns: [renameAway, "gap", recreate, "gap", remove("store.ts")],
            files: [["z.ts", "renamed", "store.ts"]],
            gone: ["store.ts"],
          },
          {
            name: "renamed away · gap · recreated · gap · both deleted",
            turns: [renameAway, "gap", recreate, "gap", remove("store.ts"), "gap", remove("z.ts")],
            files: [["store.ts", "deleted", null]],
            gone: ["z.ts"],
          },
          {
            name: "renamed away · gap · recreated · gap · the renamed one modified",
            turns: [renameAway, "gap", recreate, "gap", (d) => writeFileSync(join(d, "z.ts"), "export class Store {\n  list() {\n    return [2];\n  }\n}\n")],
            files: [
              ["store.ts", "added", null],
              ["z.ts", "renamed", "store.ts"],
            ],
            gone: [],
            replacement: "only",
          },
        ];
        for (const [i, c] of cases.entries()) {
          const t = setup();
          const app = repo("app");
          const id = `u${i}`;
          for (const [n, step] of c.turns.entries()) {
            const seq = (n + 1) * 10;
            if (step === "gap") {
              await turn(t, id, seq, app.dir, write(app.dir, `gap${n}.ts`, `export const gap${n} = ${n};\n`));
              t.tracker.setDismissed(id, seq, true);
            } else await turn(t, id, seq, app.dir, () => step(app.dir));
          }
          const { section } = await t.tracker.sessionChanges(id, "Worker");
          const files = section?.repos.flatMap((r) => r.files.map((f): [string, string, string | null] => [f.path, f.status, f.oldPath])) ?? [];
          expect([c.name, files]).toEqual([c.name, c.files]);
          for (const path of c.gone) expect([c.name, path, await t.tracker.file(id, app.dir, path)]).toEqual([c.name, path, null]);
          for (const [path] of c.files) expect([c.name, path, (await t.tracker.file(id, app.dir, path)) !== null]).toEqual([c.name, path, true]);
          if (c.replacement) {
            const lines = (await t.tracker.file(id, app.dir, "store.ts"))?.symbols.flatMap((s) => s.hunks.flatMap((h) => h.lines)) ?? [];
            expect([c.name, lines.some((l) => l.kind === "add" && l.text === REPLACEMENT)]).toEqual([c.name, true]);
            if (c.replacement === "only") expect([c.name, lines.filter((l) => l.kind === "del")]).toEqual([c.name, []]);
          }
        }
      },
      GIT_HEAVY,
    );

    // Pinned: clearing a turn removes its entries (file rows, summaries, notes), not every line
    // it wrote. A later shown turn's diff is the real before/after of that turn, so a line the
    // cleared turn wrote shows there as deleted or as context. Intended; do not "fix".
    it("shows a cleared turn's lines where a later shown turn deletes them or edits next to them", async () => {
      const t = setup();
      const { tracker } = t;
      const app = repo("app");
      const lines = (diff: Awaited<ReturnType<typeof tracker.file>>) => diff?.symbols.flatMap((s) => s.hunks.flatMap((h) => h.lines)) ?? [];
      await turn(t, "p4", 10, app.dir, write(app.dir, "a.ts", "export const one = 1;\nexport const two = 2;\n"));
      await turn(t, "p4", 20, app.dir, () => {
        writeFileSync(join(app.dir, "secret.ts"), "export const secret = 2;\n");
        writeFileSync(join(app.dir, "a.ts"), "export const one = 1;\nexport const cleared = 9;\nexport const two = 2;\n");
      });
      await turn(t, "p4", 30, app.dir, () => {
        rmSync(join(app.dir, "secret.ts"));
        writeFileSync(join(app.dir, "a.ts"), "export const one = 1;\nexport const cleared = 9;\nexport const two = 22;\n");
      });
      tracker.setDismissed("p4", 20, true);
      const { section } = await tracker.sessionChanges("p4", "Worker");
      // The later turn deleted the cleared turn's file: listed as its deletion, the cleared line deleted.
      expect(section?.repos[0]?.files.map((f) => [f.path, f.status])).toEqual([
        ["a.ts", "added"],
        ["secret.ts", "deleted"],
      ]);
      expect(lines(await tracker.file("p4", app.dir, "secret.ts"))).toContainEqual(expect.objectContaining({ kind: "del", text: "export const secret = 2;" }));
      // It edited next to the cleared turn's line: that line is its context.
      expect(lines(await tracker.file("p4", app.dir, "a.ts"))).toContainEqual(expect.objectContaining({ kind: "ctx", text: "export const cleared = 9;" }));
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

    it(
      "compares a branch with where it was created, and a worker's worktree with its base branch",
      async () => {
        const { tracker } = setup();
        const work = cloned();
        // The checkout is on a feature branch ahead of origin/main; a worker's worktree is
        // created from it (as Apollo does). The feature's commits are not the worker's.
        work.git("checkout", "-qb", "feature");
        writeFileSync(join(work.dir, "feature.ts"), "export const feature = 1;\n");
        work.git("add", "-A");
        work.git("commit", "-qm", "feature");
        const forked = work.git("rev-parse", "HEAD").trim();
        const path = join(realpathSync(mkdtempSync(join(tmpdir(), "apollo-wt-"))), "wt");
        work.git("worktree", "add", "-q", "-b", "apollo/worker-1a2b", path, forked);
        const wt = (...args: Array<string>) => execFileSync("git", args, { cwd: path, encoding: "utf8" });
        writeFileSync(join(path, "worker.ts"), "export const worker = 1;\n");
        wt("add", "-A");
        wt("commit", "-qm", "worker");
        const one = await tracker.report(path);
        expect(one.report.base).toMatchObject({ ref: "start of apollo/worker-1a2b", commit: forked });
        expect([one.report.commitCount, one.repo.files.map((f) => f.path)]).toEqual([1, ["worker.ts"]]);

        // The feature moves on and the worker merges it: with its session's worktree, its base
        // branch's own work stays out.
        writeFileSync(join(work.dir, "later.ts"), "export const later = 1;\n");
        work.git("add", "-A");
        work.git("commit", "-qm", "later");
        wt("merge", "-q", "--no-edit", "feature");
        const worktree = { repoPath: work.dir, path, branch: "apollo/worker-1a2b", baseRef: forked, baseBranch: "feature" };
        const two = await tracker.report(path, undefined, undefined, [worktree]);
        expect(two.report.base.ref).toBe("feature");
        expect(two.repo.files.map((f) => f.path)).toEqual(["worker.ts"]);
        // Without it, git alone knows where the branch started, not what came in since.
        expect((await tracker.report(path)).repo.files.map((f) => f.path)).toEqual(["later.ts", "worker.ts"]);

        // The checkout itself: a branch cloned from the origin keeps the origin's merge base.
        work.git("checkout", "-q", "main");
        writeFileSync(join(work.dir, "unpushed.ts"), "export const unpushed = 1;\n");
        work.git("add", "-A");
        work.git("commit", "-qm", "unpushed");
        const main = await tracker.report(work.dir);
        expect([main.report.base.ref, main.repo.files.map((f) => f.path)]).toEqual(["origin/main", ["unpushed.ts"]]);
        // An explicit base is taken as asked.
        expect((await tracker.report(path, "origin/main")).repo.files.map((f) => f.path)).toEqual(["feature.ts", "later.ts", "worker.ts"]);
      },
      GIT_HEAVY,
    );

    it(
      "trusts a worker's recorded base only while it describes the checkout, and never hides the branch's own commits",
      async () => {
        const { tracker } = setup();
        const work = cloned();
        const initial = work.git("rev-parse", "HEAD").trim();
        work.git("branch", "feature-base");
        const path = join(realpathSync(mkdtempSync(join(tmpdir(), "apollo-wt-"))), "wt");
        work.git("worktree", "add", "-q", "-b", "apollo/original", path, "feature-base");
        const wt = (...args: Array<string>) => execFileSync("git", args, { cwd: path, encoding: "utf8" });
        const hint = { repoPath: work.dir, path, branch: "apollo/original", baseRef: initial, baseBranch: "feature-base" };
        const files = async () => (await tracker.report(path, undefined, undefined, [hint])).repo.files.map((f) => f.path);

        // The worker's base branch merges (here: takes) its commit: the hint must not hide it.
        writeFileSync(join(path, "mine.ts"), "export const mine = 1;\n");
        wt("add", "-A");
        wt("commit", "-qm", "mine");
        work.git("update-ref", "refs/heads/feature-base", wt("rev-parse", "HEAD").trim());
        expect(await files()).toEqual(["mine.ts"]);

        // The worktree now has another branch checked out; the record is stale.
        wt("checkout", "-qb", "different", initial);
        writeFileSync(join(path, "other.ts"), "export const other = 1;\n");
        wt("add", "-A");
        wt("commit", "-qm", "other");
        work.git("update-ref", "refs/heads/feature-base", wt("rev-parse", "HEAD").trim());
        expect(await files()).toEqual(["other.ts"]);
        // The stale record's base branch is just some branch this one merged: its work shows.
        work.git("checkout", "-q", "-B", "feature-base", initial);
        writeFileSync(join(work.dir, "theirs.ts"), "export const theirs = 1;\n");
        work.git("add", "-A");
        work.git("commit", "-qm", "theirs");
        work.git("checkout", "-q", "main");
        wt("merge", "-q", "--no-edit", "feature-base");
        expect(await files()).toEqual(["other.ts", "theirs.ts"]);
      },
      GIT_HEAVY,
    );

    it(
      "never takes a base branch that absorbed the worker's own merge, a conflict it resolved",
      async () => {
        const { tracker } = setup();
        const work = cloned();
        work.git("checkout", "-qb", "side");
        writeFileSync(join(work.dir, "store.ts"), "export class Store { side = 1 }\n");
        work.git("commit", "-qam", "side");
        work.git("checkout", "-q", "main");
        writeFileSync(join(work.dir, "store.ts"), "export class Store { main = 1 }\n");
        work.git("commit", "-qam", "main");
        const base = work.git("rev-parse", "HEAD").trim();
        work.git("update-ref", "refs/remotes/origin/main", base);
        work.git("branch", "feature-base");
        const path = join(realpathSync(mkdtempSync(join(tmpdir(), "apollo-wt-"))), "wt");
        work.git("worktree", "add", "-q", "-b", "worker", path, "feature-base");
        const wt = (...args: Array<string>) => execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: "pipe" });
        // The worker's only commit: a merge whose conflict it resolved (taking the other side).
        expect(() => wt("merge", "-q", "side")).toThrow();
        wt("checkout", "--theirs", "store.ts");
        wt("add", "-A");
        wt("commit", "-q", "--no-edit");
        work.git("checkout", "-q", "feature-base");
        work.git("merge", "-q", "--ff-only", "worker");
        const hint = { repoPath: work.dir, path, branch: "worker", baseRef: base, baseBranch: "feature-base" };
        const { repo: changes, report } = await tracker.report(path, undefined, undefined, [hint]);
        expect(changes.files.map((f) => f.path)).toEqual(["store.ts"]);
        expect(report.base.commit).toBe(base);
      },
      GIT_HEAVY,
    );

    it(
      "never mixes two branches in one report when HEAD switches branch at the same commit",
      async () => {
        const { tracker } = setup();
        const work = cloned();
        const base = work.git("rev-parse", "HEAD").trim();
        work.git("branch", "feature-base");
        const path = join(realpathSync(mkdtempSync(join(tmpdir(), "apollo-wt-"))), "wt");
        work.git("worktree", "add", "-q", "-b", "worker", path, "feature-base");
        const wt = (...args: Array<string>) => execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: "pipe" });
        writeFileSync(join(path, "mine.ts"), "export const mine = 1;\n");
        wt("add", "-A");
        wt("commit", "-qm", "mine");
        work.git("branch", "different", wt("rev-parse", "HEAD").trim());
        const hint = { repoPath: work.dir, path, branch: "worker", baseRef: base, baseBranch: "feature-base" };
        expect((await tracker.report(path, undefined, undefined, [hint])).repo.files.map((f) => f.path)).toEqual(["mine.ts"]);
        // After the report has read HEAD and its branch, at the next branch read, the worktree
        // switches to `different` (same commit).
        const spawn = childProcess.spawn;
        let reads = 0;
        childProcess.spawn = ((command: string, args: ReadonlyArray<string>, options: object) => {
          if (command === "git" && args[0] === "symbolic-ref" && args.at(-1) === "HEAD" && ++reads === 2) wt("checkout", "-q", "different");
          return spawn(command, args, options);
        }) as typeof childProcess.spawn;
        syncBuiltinESMExports();
        try {
          const { repo: changes, report } = await tracker.report(path, undefined, undefined, [hint]);
          // Read again from the start: one branch throughout (`different`, which did nothing of its own).
          expect([report.head.branch, report.base.ref, changes.files.map((f) => f.path)]).toEqual(["different", "start of different", []]);
        } finally {
          childProcess.spawn = spawn;
          syncBuiltinESMExports();
        }
        // Switched there and back between the reads: the baseline is still picked for the
        // branch read with the commit, never for the one seen in between.
        wt("checkout", "-q", "worker");
        reads = 0;
        childProcess.spawn = ((command: string, args: ReadonlyArray<string>, options: object) => {
          if (command === "git" && args[0] === "symbolic-ref" && args.at(-1) === "HEAD") {
            if (++reads === 2) wt("checkout", "-q", "different");
            if (reads === 3) wt("checkout", "-q", "worker");
          }
          return spawn(command, args, options);
        }) as typeof childProcess.spawn;
        syncBuiltinESMExports();
        try {
          const { repo: changes, report } = await tracker.report(path, undefined, undefined, [hint]);
          expect([report.head.branch, changes.files.map((f) => f.path)]).toEqual(["worker", ["mine.ts"]]);
          expect(report.base.ref).not.toBe("start of different");
        } finally {
          childProcess.spawn = spawn;
          syncBuiltinESMExports();
        }
      },
      GIT_HEAVY,
    );

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
