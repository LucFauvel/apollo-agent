import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "./Config.ts";

/**
 * Ordered schema migrations. Append only: never edit a migration that has shipped.
 * Exported for the release smoke test, which seeds a database at an old version.
 */
export const MIGRATIONS: ReadonlyArray<string> = [
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
  // 8: scheduled tasks and heartbeats.
  `
  create table schedules (
    id text primary key,
    bot_id text not null references bots(id) on delete cascade,
    kind text not null,                -- 'task' | 'heartbeat'
    name text not null,
    prompt text not null,
    spec text not null,
    timezone text not null,
    provider text,                     -- task runs; null uses the bot's default worker
    model text,
    effort text,
    cwd text,
    enabled integer not null default 1,
    created_by text not null,          -- 'user' | 'bot'
    next_run_at integer,
    last_run_at integer,
    last_status text,
    failure_streak integer not null default 0,
    run_count integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  );
  create index schedules_bot on schedules(bot_id);
  create table schedule_runs (
    id text primary key,
    schedule_id text not null references schedules(id) on delete cascade,
    session_id text references sessions(id) on delete set null,
    started_at integer not null,
    finished_at integer,
    status text not null,
    summary text
  );
  create index schedule_runs_schedule on schedule_runs(schedule_id, started_at);
  `,
  // 9: bot avatars.
  `
  alter table bots add column avatar text;     -- JSON BotAvatar; null derives one from the id
  `,
  // 10: messages the user kept out of the bot's memory (search, session reads, reflection).
  `
  create table memory_exclusions (
    session_id text not null references sessions(id) on delete cascade,
    seq integer not null,
    primary key (session_id, seq)
  );
  `,
  // 11: workers in their own git worktree.
  `
  alter table sessions add column worktree text;     -- JSON SessionWorktree
  `,
  // 12: pull requests linked to sessions, and what Apollo last saw of them.
  `
  create table pull_requests (
    session_id text not null references sessions(id) on delete cascade,
    url text not null,
    data text not null,                 -- JSON PullRequest
    digest text not null default '',    -- last seen checks, reviews and comments
    primary key (session_id, url)
  );
  `,
  // 13: how full each session's context window is.
  `
  alter table sessions add column context text;     -- JSON { used, window }
  `,
  // 14: phones that get push notifications, per paired client.
  `
  create table push_tokens (
    token text primary key,             -- Expo push token
    client_id text not null,
    platform text not null,
    created_at integer not null
  );
  `,
  // 15: clients bound to one tailnet device, and device keys that sign every request.
  `
  alter table client_sessions add column node_id text;     -- Tailscale StableID
  alter table client_sessions add column user_id text;     -- Tailscale user ID of that node
  alter table client_sessions add column node_name text;
  alter table client_sessions add column device_key text;  -- base64url uncompressed P-256 point
  `,
  // 16: what each turn changed in git repositories, and workers' explanations of it.
  `
  create table turn_changes (
    session_id text not null references sessions(id) on delete cascade,
    turn_seq integer not null,          -- seq of the turn's TurnStarted event
    repo text not null,                 -- the repository (or worktree) folder
    git_dir text not null,              -- its common git dir, where the snapshot trees live
    before_tree text not null,
    after_tree text not null,
    files text not null,                -- JSON ChangedFile[]
    created_at integer not null,
    primary key (session_id, turn_seq, repo)
  );
  create table change_notes (
    session_id text not null references sessions(id) on delete cascade,
    turn_seq integer not null,
    repo text not null,                 -- '' for a summary of the turn
    path text not null,                 -- '' for a summary of the turn
    symbol text not null,               -- '' for the whole file
    text text not null,
    created_at integer not null,
    primary key (session_id, turn_seq, repo, path, symbol)
  );
  `,
  // 17: the Claude account a bot's Claude sessions use (null: this machine's own login).
  `
  alter table bots add column claude_account_id text;
  `,
  // 18: the same for Codex sessions.
  `
  alter table bots add column codex_account_id text;
  `,
  // 19: turns' changes cards the user cleared from the conversation (the changes stay).
  `
  create table dismissed_changes (
    session_id text not null references sessions(id) on delete cascade,
    seq integer not null,               -- the FilesChanged event
    primary key (session_id, seq)
  );
  `,
];

/**
 * The schema version this code migrates a database to (`pragma user_version`). The desktop
 * installer refuses to install code older than the database it would run against.
 */
export const SCHEMA_VERSION = MIGRATIONS.length;

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
