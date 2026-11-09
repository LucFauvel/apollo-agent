/**
 * Seeding and checking the "old database" for the release smoke test (smoke.ts). Pure enough to
 * unit-test against the real migrations: the test opens a seeded database with the server's own
 * `open()` and checks what smoke.ts checks after the packaged app ran.
 */
import { DatabaseSync } from "node:sqlite";

/** What gets seeded, so it can be found again after the app migrated the database. */
export const SEED = {
  botId: "smoke-bot",
  mainSessionId: "smoke-main",
  workerSessionId: "smoke-worker",
  memoryId: "smoke-memory",
  skillId: "smoke-skill",
  marker: "release-smoke-seed",
} as const;

/** The oldest schema the seed rows below are written for: migration 1 (the first release). */
export const SEED_MIN_VERSION = 1;

/**
 * Creates `path` at schema `version` (migrations [0, version) applied, `user_version = version`),
 * the way a user who last ran that version has it, then writes a bot with a main and a worker
 * session, events, a memory (with its FTS index) and a skill using only the columns migration 1
 * created. Every later migration must carry these rows forward.
 */
export const seedOldDatabase = (path: string, migrations: ReadonlyArray<string>, version: number): void => {
  if (!Number.isInteger(version) || version < SEED_MIN_VERSION || version > migrations.length) {
    throw new Error(`seed version ${version} is outside 1..${migrations.length}`);
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
    for (let v = 0; v < version; v++) {
      db.exec("begin");
      db.exec(migrations[v]!);
      db.exec(`pragma user_version = ${v + 1}`);
      db.exec("commit");
    }
    const t = 1_762_560_000_000; // 2025-11-08, older than any real data the migrations meet
    db.exec("begin");
    db.prepare(
      `insert into bots (id, name, instructions, cwd, main_provider, main_model, worker_provider, worker_model,
         runtime_mode, auto_learn, main_session_id, created_at, updated_at)
       values (?, 'Smoke', ?, '/tmp', 'claude', null, 'claude', null, 'full-access', 0, ?, ?, ?)`,
    ).run(SEED.botId, SEED.marker, SEED.mainSessionId, t, t);
    const session = db.prepare(
      `insert into sessions (id, bot_id, role, parent_session_id, title, provider, model, cwd, status, resume_id,
         last_message, completed_turns, turns_since_reflection, created_at, updated_at)
       values (?, ?, ?, ?, ?, 'claude', null, '/tmp', 'idle', null, ?, 1, 0, ?, ?)`,
    );
    session.run(SEED.mainSessionId, SEED.botId, "main", null, "Smoke main", SEED.marker, t, t);
    session.run(SEED.workerSessionId, SEED.botId, "worker", SEED.mainSessionId, "Smoke worker", SEED.marker, t, t);
    const event = db.prepare("insert into session_events (session_id, seq, at, event) values (?, ?, ?, ?)");
    event.run(SEED.mainSessionId, 1, t, JSON.stringify({ _tag: "UserMessage", text: SEED.marker, author: "user" }));
    event.run(SEED.mainSessionId, 2, t + 1, JSON.stringify({ _tag: "AssistantMessage", itemId: "smoke-item", text: "ok" }));
    db.prepare(
      `insert into memories (id, bot_id, kind, content, tags, source_session_id, pinned, created_at)
       values (?, ?, 'fact', ?, 'smoke', null, 0, ?)`,
    ).run(SEED.memoryId, SEED.botId, `the ${SEED.marker} memory`, t);
    db.prepare(
      `insert into skills (id, bot_id, name, description, body, status, version, source_session_id, created_at, updated_at)
       values (?, ?, 'smoke-skill', 'Seeded by the release smoke test', ?, 'active', 1, null, ?, ?)`,
    ).run(SEED.skillId, SEED.botId, SEED.marker, t, t);
    db.exec("commit");
  } finally {
    db.close();
  }
};

const count = (db: DatabaseSync, sql: string, ...params: Array<string>): number =>
  Number((db.prepare(sql).get(...params) as { n: number | bigint }).n);

/** What is wrong with the database after the app ran on it; empty when it migrated and kept the seed. */
export const checkMigratedDatabase = (path: string, expectedVersion: number): Array<string> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const problems: Array<string> = [];
    const version = (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
    if (version !== expectedVersion) problems.push(`schema version ${version}, expected ${expectedVersion}`);
    const integrity = (db.prepare("pragma integrity_check").get() as { integrity_check: string }).integrity_check;
    if (integrity !== "ok") problems.push(`integrity_check: ${integrity}`);
    if (count(db, "select count(*) as n from bots where id = ? and instructions = ?", SEED.botId, SEED.marker) !== 1) problems.push("the seeded bot is gone");
    if (count(db, "select count(*) as n from sessions where bot_id = ?", SEED.botId) !== 2) problems.push("the seeded sessions are gone");
    if (count(db, "select count(*) as n from session_events where session_id = ?", SEED.mainSessionId) < 2) problems.push("the seeded session events are gone");
    if (count(db, "select count(*) as n from memories where id = ?", SEED.memoryId) !== 1) problems.push("the seeded memory is gone");
    if (count(db, "select count(*) as n from memories_fts where memories_fts match ?", `"${SEED.marker}"`) < 1) problems.push("the memory search index lost the seeded memory");
    if (count(db, "select count(*) as n from skills where id = ?", SEED.skillId) !== 1) problems.push("the seeded skill is gone");
    return problems;
  } finally {
    db.close();
  }
};
