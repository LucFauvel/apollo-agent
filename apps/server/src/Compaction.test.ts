import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { dropDetail, reclaim, tidy, usedBytes } from "./Compaction.ts";
import * as Database from "./Database.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const policy = { budgetBytes: 1e9, archiveLimit: 3, detailRetentionMs: 30 * DAY };

const setup = (): DatabaseSync => {
  const db = Database.open(join(mkdtempSync(join(tmpdir(), "apollo-compact-")), "apollo.db"));
  db.exec(`
    insert into bots (id, name, instructions, cwd, main_provider, worker_provider, runtime_mode, auto_learn,
      main_session_id, created_at, updated_at)
      values ('a', 'A', '', '/tmp', 'claude', 'codex', 'full-access', 0, 'a-main', 0, 0);
    insert into sessions (id, bot_id, role, title, provider, cwd, status, created_at, updated_at)
      values ('s', 'a', 'worker', 'S', 'codex', '/tmp', 'idle', 0, 0);
  `);
  return db;
};

const addEvent = (db: DatabaseSync, seq: number, at: number, event: object) =>
  db.prepare("insert into session_events values ('s', ?, ?, ?)").run(seq, at, JSON.stringify(event));

const eventAt = (db: DatabaseSync, seq: number) =>
  JSON.parse((db.prepare("select event from session_events where seq = ?").get(seq) as { event: string }).event);

describe("compaction", () => {
  it("trims old tool output and reasoning but leaves recent detail and messages", () => {
    const db = setup();
    const long = "x".repeat(5000);
    addEvent(db, 1, NOW - 40 * DAY, { _tag: "ToolCompleted", itemId: "t", output: long, isError: false });
    addEvent(db, 2, NOW - 40 * DAY, { _tag: "Reasoning", itemId: "r", text: long });
    addEvent(db, 3, NOW - 40 * DAY, { _tag: "AssistantMessage", itemId: "m", text: long });
    addEvent(db, 4, NOW - DAY, { _tag: "ToolCompleted", itemId: "u", output: long, isError: false });

    expect(tidy(db, policy, NOW).trimmedEvents).toBe(2);
    expect(eventAt(db, 1).output).toHaveLength(301);
    expect(eventAt(db, 2).text).toHaveLength(301);
    expect(eventAt(db, 3).text).toHaveLength(5000);
    expect(eventAt(db, 4).output).toHaveLength(5000);
    // Idempotent: nothing left to trim.
    expect(tidy(db, policy, NOW).trimmedEvents).toBe(0);
  });

  it("evicts the least recently used archive memories over the limit, per scope", () => {
    const db = setup();
    const insert = db.prepare(
      "insert into memories (id, bot_id, kind, content, tags, created_at, last_used_at) values (?, ?, 'fact', ?, '[]', ?, ?)",
    );
    // m1 is the oldest but was recalled recently, so m2 and m3 go first.
    insert.run("m1", "a", "one", 1, 90);
    insert.run("m2", "a", "two", 2, null);
    insert.run("m3", "a", "three", 3, null);
    insert.run("m4", "a", "four", 4, null);
    insert.run("m5", "a", "five", 5, null);
    insert.run("g1", null, "global", 1, null);

    expect(tidy(db, policy, NOW).evictedMemories).toBe(2);
    const left = (db.prepare("select id from memories order by id").all() as Array<{ id: string }>).map((r) => r.id);
    expect(left).toEqual(["g1", "m1", "m4", "m5"]);
    const fts = db.prepare("select count(*) as n from memories_fts where memories_fts match 'two'").get() as { n: number };
    expect(fts.n).toBe(0);
  });

  it("keeps only the newest archived versions of a skill", () => {
    const db = setup();
    const insert = db.prepare(
      "insert into skills (id, bot_id, name, description, body, status, version, created_at, updated_at) values (?, 'a', 'deploy', '', '', ?, ?, 0, 0)",
    );
    for (let v = 1; v <= 8; v++) insert.run(`k${v}`, v === 8 ? "active" : "archived", v);
    expect(tidy(db, policy, NOW).deletedSkillVersions).toBe(2);
    const versions = (db.prepare("select version from skills order by version").all() as Array<{ version: number }>).map(
      (r) => r.version,
    );
    expect(versions).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("drops tool events past a cutoff and hands the space back to the OS", () => {
    const db = setup();
    const output = "y".repeat(3000);
    for (let i = 1; i <= 4000; i++) {
      addEvent(db, i, NOW - 10 * DAY, { _tag: "ToolCompleted", itemId: `t${i}`, output, isError: false });
    }
    addEvent(db, 4001, NOW - 10 * DAY, { _tag: "UserMessage", text: "keep me", author: "user" });
    reclaim(db);
    const file = (db.prepare("pragma database_list").get() as { file: string }).file;
    const before = statSync(file).size;

    expect(dropDetail(db, NOW - 7 * DAY)).toBe(4000);
    reclaim(db);

    expect(statSync(file).size).toBeLessThan(before / 10);
    expect(usedBytes(db)).toBeLessThan(before / 10);
    expect(eventAt(db, 4001).text).toBe("keep me");
  });
});
