import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "./Config.ts";

/**
 * Ordered schema migrations. Append only: never edit a migration that has shipped.
 */
const MIGRATIONS: ReadonlyArray<string> = [
  `
  create table bots (
    id text primary key,
    name text not null,
    instructions text not null,
    cwd text not null,
    main_provider text not null,
    main_model text,
    worker_provider text not null,
    worker_model text,
    runtime_mode text not null,
    auto_learn integer not null,
    main_session_id text not null,
    created_at integer not null,
    updated_at integer not null
  );

  create table sessions (
    id text primary key,
    bot_id text not null references bots(id) on delete cascade,
    role text not null,
    parent_session_id text,
    title text not null,
    provider text not null,
    model text,
    cwd text not null,
    status text not null,
    resume_id text,
    last_message text,
    completed_turns integer not null default 0,
    turns_since_reflection integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  );
  create index sessions_bot on sessions(bot_id);

  create table session_events (
    session_id text not null references sessions(id) on delete cascade,
    seq integer not null,
    at integer not null,
    event text not null,
    primary key (session_id, seq)
  );

  create table memories (
    id text primary key,
    bot_id text references bots(id) on delete cascade,
    kind text not null,
    content text not null,
    tags text not null,
    source_session_id text,
    pinned integer not null default 0,
    created_at integer not null
  );
  create virtual table memories_fts using fts5(content, tags, content='memories', content_rowid='rowid');
  create trigger memories_ai after insert on memories begin
    insert into memories_fts(rowid, content, tags) values (new.rowid, new.content, new.tags);
  end;
  create trigger memories_ad after delete on memories begin
    insert into memories_fts(memories_fts, rowid, content, tags) values ('delete', old.rowid, old.content, old.tags);
  end;
  create trigger memories_au after update on memories begin
    insert into memories_fts(memories_fts, rowid, content, tags) values ('delete', old.rowid, old.content, old.tags);
    insert into memories_fts(rowid, content, tags) values (new.rowid, new.content, new.tags);
  end;

  create table skills (
    id text primary key,
    bot_id text references bots(id) on delete cascade,
    name text not null,
    description text not null,
    body text not null,
    status text not null,
    version integer not null,
    source_session_id text,
    created_at integer not null,
    updated_at integer not null
  );
  -- One active version per name and scope; proposals and archived versions sit beside it.
  create unique index skills_active_name on skills(coalesce(bot_id, ''), name) where status = 'active';
  `,
  // 2: workers that report their finished turns back to the session that spawned them.
  `alter table sessions add column notify_parent integer not null default 0;`,
  // 3: device pairing. Only SHA-256 hashes of tokens are stored.
  `
  create table pairing_grants (
    token_hash text primary key,
    label text not null,
    created_at integer not null,
    expires_at integer not null,
    used_at integer
  );
  create table client_sessions (
    id text primary key,
    token_hash text not null unique,
    label text not null,
    method text not null,
    created_at integer not null,
    expires_at integer not null,
    last_seen_at integer not null,
    revoked_at integer
  );
  `,
  // 4: core memory, least-used eviction for the archive, transcript search.
  `
  create table core_memory (
    scope text not null,              -- 'global' for the user profile, else a bot id
    target text not null,             -- 'user' | 'notes'
    entries text not null,            -- JSON array of strings
    updated_at integer not null,
    primary key (scope, target)
  );
  alter table memories add column last_used_at integer;
  create index memories_scope on memories(coalesce(bot_id, ''), coalesce(last_used_at, created_at));

  -- Messages only (not tool output), keyed by the session_events rowid.
  create virtual table transcript_fts using fts5(text, session_id unindexed, seq unindexed);
  create trigger transcript_ai after insert on session_events
    when json_extract(new.event, '$._tag') in ('UserMessage', 'AssistantMessage') begin
    insert into transcript_fts(rowid, text, session_id, seq)
      values (new.rowid, json_extract(new.event, '$.text'), new.session_id, new.seq);
  end;
  create trigger transcript_ad after delete on session_events begin
    delete from transcript_fts where rowid = old.rowid;
  end;
  insert into transcript_fts(rowid, text, session_id, seq)
    select rowid, json_extract(event, '$.text'), session_id, seq from session_events
    where json_extract(event, '$._tag') in ('UserMessage', 'AssistantMessage');
  create index session_events_at on session_events(at);
  `,
  // 5: reasoning effort, and per-session runtime mode overrides.
  `
  alter table bots add column main_effort text;
  alter table bots add column worker_effort text;
  alter table sessions add column effort text;
  alter table sessions add column runtime_mode text;
  `,
  // 6: usage tracking and guardrails.
  `
  alter table bots add column limits text;          -- JSON BotLimits; null means defaults
  alter table bots add column paused_reason text;
  alter table sessions add column usage text;        -- JSON Usage counted by Apollo
  alter table sessions add column provider_usage text; -- last running total the provider reported
  create table usage_daily (
    bot_id text not null references bots(id) on delete cascade,
    day text not null,                               -- server-local YYYY-MM-DD
    input_tokens integer not null default 0,
    cached_input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    cost_usd real not null default 0,
    primary key (bot_id, day)
  );
  `,
  // 7: app-wide settings (provider credentials and endpoints).
  `
  create table settings (
    key text primary key,
    value text not null
  );
  `,
];

export class Database extends Context.Service<Database, DatabaseSync>()("apollo/Database") {}

export const open = (path: string): DatabaseSync => {
  // Incremental auto-vacuum lets compaction hand freed pages back to the OS. It only
  // takes effect after a VACUUM, which is instant on a new database.
  const db = new DatabaseSync(path);
  if ((db.prepare("pragma auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum !== 2) {
    db.exec("pragma auto_vacuum = incremental; vacuum;");
  }
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  const row = db.prepare("pragma user_version").get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec("begin");
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`pragma user_version = ${version + 1}`);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }
  return db;
};

export const layer = Layer.effect(
  Database,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* Effect.acquireRelease(
      Effect.sync(() => {
        mkdirSync(config.dataDir, { recursive: true });
        return open(join(config.dataDir, "apollo.db"));
      }),
      (db) => Effect.sync(() => db.close()),
    );
  }),
);

export const layerMemory = Layer.effect(
  Database,
  Effect.acquireRelease(
    Effect.sync(() => open(":memory:")),
    (db) => Effect.sync(() => db.close()),
  ),
);
