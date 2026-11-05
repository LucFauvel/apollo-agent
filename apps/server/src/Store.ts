import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  type AgentEvent,
  ApolloError,
  type Bot,
  type BotId,
  CORE_MEMORY_LIMITS,
  type CoreMemory,
  type CoreMemoryTarget,
  coreMemoryUsage,
  type Memory,
  type MemoryId,
  type MemoryKind,
  type ProviderKind,
  type RuntimeMode,
  type Session,
  type SessionEvent,
  type SessionId,
  type SessionRole,
  type SessionStatus,
  type Skill,
  type SkillId,
  type SkillStatus,
} from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Database } from "./Database.ts";

export const newId = <T extends string>(prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}` as T;

const notFound = (what: string) => new ApolloError({ code: "not_found", message: `${what} not found` });

type Row = Record<string, SQLInputValue>;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const toBot = (r: Row): Bot => ({
  id: r.id as BotId,
  name: r.name as string,
  instructions: r.instructions as string,
  cwd: r.cwd as string,
  main: {
    provider: r.main_provider as ProviderKind,
    ...(r.main_model ? { model: r.main_model as string } : {}),
  },
  defaultWorker: {
    provider: r.worker_provider as ProviderKind,
    ...(r.worker_model ? { model: r.worker_model as string } : {}),
  },
  runtimeMode: r.runtime_mode as RuntimeMode,
  autoLearn: r.auto_learn === 1,
  mainSessionId: r.main_session_id as SessionId,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const toSession = (r: Row): Session => ({
  id: r.id as SessionId,
  botId: r.bot_id as BotId,
  role: r.role as SessionRole,
  parentSessionId: (r.parent_session_id as SessionId | null) ?? null,
  title: r.title as string,
  provider: r.provider as ProviderKind,
  model: (r.model as string | null) ?? null,
  cwd: r.cwd as string,
  status: r.status as SessionStatus,
  resumeId: (r.resume_id as string | null) ?? null,
  lastMessage: (r.last_message as string | null) ?? null,
  completedTurns: Number(r.completed_turns),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const toMemory = (r: Row): Memory => ({
  id: r.id as MemoryId,
  botId: (r.bot_id as BotId | null) ?? null,
  kind: r.kind as MemoryKind,
  content: r.content as string,
  tags: JSON.parse(r.tags as string) as Array<string>,
  sourceSessionId: (r.source_session_id as SessionId | null) ?? null,
  createdAt: Number(r.created_at),
  lastUsedAt: r.last_used_at === null || r.last_used_at === undefined ? null : Number(r.last_used_at),
});

/** Lowercased, whitespace-collapsed text: two memories with the same key are duplicates. */
const dedupeKey = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[.!\s]+$/, "").trim();

/** One message found by transcript search. */
export interface TranscriptHit {
  readonly sessionId: SessionId;
  readonly sessionTitle: string;
  readonly provider: ProviderKind;
  readonly seq: number;
  readonly at: number;
  readonly excerpt: string;
}

const toSkill = (r: Row): Skill => ({
  id: r.id as SkillId,
  botId: (r.bot_id as BotId | null) ?? null,
  name: r.name as string,
  description: r.description as string,
  body: r.body as string,
  status: r.status as SkillStatus,
  version: Number(r.version),
  sourceSessionId: (r.source_session_id as SessionId | null) ?? null,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/** Turns free text into a safe FTS5 query: OR of quoted terms. */
const ftsQuery = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 1)
    .map((term) => `"${term}"`)
    .join(" OR ");

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface SessionPatch {
  readonly title?: string;
  readonly status?: SessionStatus;
  readonly resumeId?: string | null;
  readonly lastMessage?: string | null;
  readonly model?: string | null;
}

const makeStore = (db: DatabaseSync) => {
  const all = (sql: string, ...params: Array<SQLInputValue>) =>
    db.prepare(sql).all(...params) as Array<Row>;
  const get = (sql: string, ...params: Array<SQLInputValue>) =>
    db.prepare(sql).get(...params) as Row | undefined;
  const run = (sql: string, ...params: Array<SQLInputValue>) => db.prepare(sql).run(...params);
  const lastSeq = new Map<SessionId, number>();

  const getBot = (id: BotId) =>
    Effect.suspend(() => {
      const row = get("select * from bots where id = ?", id);
      return row ? Effect.succeed(toBot(row)) : Effect.fail(notFound(`bot ${id}`));
    });

  const getSession = (id: SessionId) =>
    Effect.suspend(() => {
      const row = get("select * from sessions where id = ?", id);
      return row ? Effect.succeed(toSession(row)) : Effect.fail(notFound(`session ${id}`));
    });

  return {
    // --- bots ------------------------------------------------------------
    listBots: Effect.sync(() => all("select * from bots order by created_at").map(toBot)),
    getBot,
    insertBot: (bot: Bot) =>
      Effect.sync(() => {
        run(
          `insert into bots (id, name, instructions, cwd, main_provider, main_model, worker_provider,
             worker_model, runtime_mode, auto_learn, main_session_id, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          bot.id,
          bot.name,
          bot.instructions,
          bot.cwd,
          bot.main.provider,
          bot.main.model ?? null,
          bot.defaultWorker.provider,
          bot.defaultWorker.model ?? null,
          bot.runtimeMode,
          bot.autoLearn ? 1 : 0,
          bot.mainSessionId,
          bot.createdAt,
          bot.updatedAt,
        );
        return bot;
      }),
    updateBot: (bot: Bot) =>
      Effect.sync(() => {
        run(
          `update bots set name = ?, instructions = ?, cwd = ?, worker_provider = ?, worker_model = ?,
             runtime_mode = ?, auto_learn = ?, updated_at = ? where id = ?`,
          bot.name,
          bot.instructions,
          bot.cwd,
          bot.defaultWorker.provider,
          bot.defaultWorker.model ?? null,
          bot.runtimeMode,
          bot.autoLearn ? 1 : 0,
          bot.updatedAt,
          bot.id,
        );
        return bot;
      }),
    deleteBot: (id: BotId) => Effect.sync(() => void run("delete from bots where id = ?", id)),

    // --- sessions --------------------------------------------------------
    listSessions: (botId?: BotId) =>
      Effect.sync(() =>
        (botId
          ? all("select * from sessions where bot_id = ? order by created_at", botId)
          : all("select * from sessions order by created_at")
        ).map(toSession),
      ),
    getSession,
    insertSession: (session: Session) =>
      Effect.sync(() => {
        run(
          `insert into sessions (id, bot_id, role, parent_session_id, title, provider, model, cwd,
             status, resume_id, last_message, completed_turns, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          session.id,
          session.botId,
          session.role,
          session.parentSessionId,
          session.title,
          session.provider,
          session.model,
          session.cwd,
          session.status,
          session.resumeId,
          session.lastMessage,
          session.completedTurns,
          session.createdAt,
          session.updatedAt,
        );
        return session;
      }),
    updateSession: (id: SessionId, patch: SessionPatch) =>
      Effect.gen(function* () {
        const current = yield* getSession(id);
        const next: Session = { ...current, ...patch, updatedAt: Date.now() };
        run(
          `update sessions set title = ?, status = ?, resume_id = ?, last_message = ?, model = ?,
             updated_at = ? where id = ?`,
          next.title,
          next.status,
          next.resumeId,
          next.lastMessage,
          next.model,
          next.updatedAt,
          id,
        );
        return next;
      }),
    /** Records a finished turn; returns the updated session and turns since the last reflection. */
    recordTurn: (id: SessionId) =>
      Effect.gen(function* () {
        run(
          `update sessions set completed_turns = completed_turns + 1,
             turns_since_reflection = turns_since_reflection + 1, updated_at = ? where id = ?`,
          Date.now(),
          id,
        );
        const row = get("select turns_since_reflection from sessions where id = ?", id);
        return { session: yield* getSession(id), turnsSinceReflection: Number(row?.turns_since_reflection ?? 0) };
      }),
    setNotifyParent: (id: SessionId, notify: boolean) =>
      Effect.sync(() => void run("update sessions set notify_parent = ? where id = ?", notify ? 1 : 0, id)),
    notifiesParent: (id: SessionId) =>
      Effect.sync(() => get("select notify_parent from sessions where id = ?", id)?.notify_parent === 1),
    resetReflectionCounter: (id: SessionId) =>
      Effect.sync(() => void run("update sessions set turns_since_reflection = 0 where id = ?", id)),
    /** Sessions left running by a previous process are idle now. */
    resetLiveStatuses: Effect.sync(() =>
      run(
        "update sessions set status = 'idle' where status in ('starting', 'running', 'waiting-approval')",
      ),
    ),
    deleteSession: (id: SessionId) =>
      Effect.sync(() => {
        run("delete from sessions where id = ?", id);
        lastSeq.delete(id);
      }),

    // --- events ----------------------------------------------------------
    appendEvent: (sessionId: SessionId, event: AgentEvent) =>
      Effect.sync((): SessionEvent => {
        let seq = lastSeq.get(sessionId);
        if (seq === undefined) {
          const row = get("select max(seq) as seq from session_events where session_id = ?", sessionId);
          seq = Number(row?.seq ?? 0);
        }
        seq += 1;
        lastSeq.set(sessionId, seq);
        const at = Date.now();
        run(
          "insert into session_events (session_id, seq, at, event) values (?, ?, ?, ?)",
          sessionId,
          seq,
          at,
          JSON.stringify(event),
        );
        return { sessionId, seq, at, event };
      }),
    listEvents: (sessionId: SessionId, afterSeq: number) =>
      Effect.sync(() =>
        all(
          "select * from session_events where session_id = ? and seq > ? order by seq",
          sessionId,
          afterSeq,
        ).map(
          (r): SessionEvent => ({
            sessionId,
            seq: Number(r.seq),
            at: Number(r.at),
            event: JSON.parse(r.event as string) as AgentEvent,
          }),
        ),
      ),

    // --- memories --------------------------------------------------------
    /** `botId === null` lists only global memories; otherwise bot + global. */
    listMemories: (botId: BotId | null) =>
      Effect.sync(() =>
        (botId === null
          ? all("select * from memories where bot_id is null order by created_at desc")
          : all(
              "select * from memories where bot_id = ? or bot_id is null order by created_at desc",
              botId,
            )
        ).map(toMemory),
      ),
    searchMemories: (botId: BotId, text: string, limit: number) =>
      Effect.sync(() => {
        const match = ftsQuery(text);
        if (match.length === 0) return [];
        const found = all(
          `select m.* from memories_fts f join memories m on m.rowid = f.rowid
           where memories_fts match ? and (m.bot_id = ? or m.bot_id is null)
           order by bm25(memories_fts) limit ?`,
          match,
          botId,
          limit,
        ).map(toMemory);
        // Recall keeps a memory alive: compaction evicts the least recently used.
        const now = Date.now();
        for (const m of found) run("update memories set last_used_at = ? where id = ?", now, m.id);
        return found;
      }),
    insertMemory: (input: {
      readonly botId: BotId | null;
      readonly kind: MemoryKind;
      readonly content: string;
      readonly tags: ReadonlyArray<string>;
      readonly sourceSessionId: SessionId | null;
    }) =>
      Effect.sync((): Memory => {
        // Saving something already known refreshes it instead of duplicating it.
        const key = dedupeKey(input.content);
        const sameScope = all(
          "select * from memories where coalesce(bot_id, '') = ? and length(content) between ? and ?",
          input.botId ?? "",
          key.length - 8,
          input.content.length + 8,
        ).find((r) => dedupeKey(r.content as string) === key);
        if (sameScope) {
          const now = Date.now();
          run("update memories set last_used_at = ? where id = ?", now, sameScope.id as string);
          return { ...toMemory(sameScope), lastUsedAt: now };
        }
        const memory: Memory = {
          id: newId<MemoryId>("mem"),
          botId: input.botId,
          kind: input.kind,
          content: input.content,
          tags: [...input.tags],
          sourceSessionId: input.sourceSessionId,
          createdAt: Date.now(),
          lastUsedAt: null,
        };
        run(
          `insert into memories (id, bot_id, kind, content, tags, source_session_id, created_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
          memory.id,
          memory.botId,
          memory.kind,
          memory.content,
          JSON.stringify(memory.tags),
          memory.sourceSessionId,
          memory.createdAt,
        );
        return memory;
      }),
    getMemory: (id: MemoryId) =>
      Effect.suspend(() => {
        const row = get("select * from memories where id = ?", id);
        return row ? Effect.succeed(toMemory(row)) : Effect.fail(notFound(`memory ${id}`));
      }),
    deleteMemory: (id: MemoryId) => Effect.sync(() => void run("delete from memories where id = ?", id)),

    // --- core memory -----------------------------------------------------
    /** The user profile (shared by every bot) and this bot's notes. */
    getCoreMemory: (botId: BotId) =>
      Effect.sync((): CoreMemory => {
        const read = (scope: string, target: CoreMemoryTarget) => {
          const row = get("select entries from core_memory where scope = ? and target = ?", scope, target);
          return row ? (JSON.parse(row.entries as string) as Array<string>) : [];
        };
        return { user: read("global", "user"), notes: read(botId, "notes") };
      }),
    /** Replaces one core memory list. Fails when it does not fit the budget. */
    setCoreMemory: (botId: BotId, target: CoreMemoryTarget, entries: ReadonlyArray<string>) =>
      Effect.suspend(() => {
        const clean = entries.map((e) => e.replace(/\s+/g, " ").trim()).filter((e) => e.length > 0);
        const used = coreMemoryUsage(clean);
        const limit = CORE_MEMORY_LIMITS[target];
        if (used > limit) {
          return Effect.fail(
            new ApolloError({
              code: "invalid",
              message: `core memory "${target}" would use ${used}/${limit} characters. Consolidate or shorten entries, and keep details in the archive.`,
            }),
          );
        }
        run(
          `insert into core_memory (scope, target, entries, updated_at) values (?, ?, ?, ?)
           on conflict (scope, target) do update set entries = excluded.entries, updated_at = excluded.updated_at`,
          target === "user" ? "global" : botId,
          target,
          JSON.stringify(clean),
          Date.now(),
        );
        return Effect.succeed(clean);
      }),

    // --- transcripts -------------------------------------------------------
    /** Keyword search over the messages of a bot's past sessions (not reflections). */
    searchTranscripts: (botId: BotId, text: string, limit: number, excludeSessionId: SessionId | null) =>
      Effect.sync((): Array<TranscriptHit> => {
        const match = ftsQuery(text);
        if (match.length === 0) return [];
        return all(
          `select f.session_id, f.seq, e.at, s.title, s.provider,
                  snippet(transcript_fts, 0, '**', '**', '…', 40) as excerpt
           from transcript_fts f
           join session_events e on e.rowid = f.rowid
           join sessions s on s.id = f.session_id
           where transcript_fts match ? and s.bot_id = ? and s.role != 'reflection' and s.id != ?
           order by bm25(transcript_fts) limit ?`,
          match,
          botId,
          excludeSessionId ?? "",
          limit,
        ).map((r) => ({
          sessionId: r.session_id as SessionId,
          sessionTitle: r.title as string,
          provider: r.provider as ProviderKind,
          seq: Number(r.seq),
          at: Number(r.at),
          excerpt: r.excerpt as string,
        }));
      }),
    /** Events of a session around `seq`, for reading the context of a search hit. */
    eventsAround: (sessionId: SessionId, seq: number, radius: number) =>
      Effect.sync(() =>
        all(
          "select * from session_events where session_id = ? and seq between ? and ? order by seq",
          sessionId,
          seq - radius,
          seq + radius,
        ).map(
          (r): SessionEvent => ({
            sessionId,
            seq: Number(r.seq),
            at: Number(r.at),
            event: JSON.parse(r.event as string) as AgentEvent,
          }),
        ),
      ),

    // --- skills ----------------------------------------------------------
    /** `botId === null` lists only global skills; otherwise bot + global. */
    listSkills: (botId: BotId | null) =>
      Effect.sync(() =>
        (botId === null
          ? all("select * from skills where bot_id is null order by name, version desc")
          : all(
              "select * from skills where bot_id = ? or bot_id is null order by name, version desc",
              botId,
            )
        ).map(toSkill),
      ),
    /** Active skill by name, preferring the bot's own over a global one. */
    findActiveSkill: (botId: BotId, name: string) =>
      Effect.sync(() => {
        const row = get(
          `select * from skills where name = ? and status = 'active' and (bot_id = ? or bot_id is null)
           order by bot_id is null limit 1`,
          name,
          botId,
        );
        return row ? toSkill(row) : null;
      }),
    getSkill: (id: SkillId) =>
      Effect.suspend(() => {
        const row = get("select * from skills where id = ?", id);
        return row ? Effect.succeed(toSkill(row)) : Effect.fail(notFound(`skill ${id}`));
      }),
    insertSkill: (input: {
      readonly botId: BotId | null;
      readonly name: string;
      readonly description: string;
      readonly body: string;
      readonly status: SkillStatus;
      readonly sourceSessionId: SessionId | null;
    }) =>
      Effect.sync((): Skill => {
        const latest = get(
          "select max(version) as version from skills where name = ? and coalesce(bot_id, '') = ?",
          input.name,
          input.botId ?? "",
        );
        const now = Date.now();
        const skill: Skill = {
          id: newId<SkillId>("skill"),
          botId: input.botId,
          name: input.name,
          description: input.description,
          body: input.body,
          status: input.status,
          version: Number(latest?.version ?? 0) + 1,
          sourceSessionId: input.sourceSessionId,
          createdAt: now,
          updatedAt: now,
        };
        run(
          `insert into skills (id, bot_id, name, description, body, status, version, source_session_id,
             created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          skill.id,
          skill.botId,
          skill.name,
          skill.description,
          skill.body,
          skill.status,
          skill.version,
          skill.sourceSessionId,
          skill.createdAt,
          skill.updatedAt,
        );
        return skill;
      }),
    /** Sets a skill's status; activating archives the previously active version. */
    setSkillStatus: (id: SkillId, status: SkillStatus) =>
      Effect.sync(() => {
        const row = get("select * from skills where id = ?", id);
        if (!row) return;
        const skill = toSkill(row);
        db.exec("begin");
        try {
          if (status === "active") {
            run(
              `update skills set status = 'archived', updated_at = ?
               where name = ? and coalesce(bot_id, '') = ? and status = 'active' and id != ?`,
              Date.now(),
              skill.name,
              skill.botId ?? "",
              skill.id,
            );
          }
          run("update skills set status = ?, updated_at = ? where id = ?", status, Date.now(), id);
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      }),
    deleteSkill: (id: SkillId) => Effect.sync(() => void run("delete from skills where id = ?", id)),
  };
};

export class Store extends Context.Service<Store, ReturnType<typeof makeStore>>()("apollo/Store") {}

export const layer = Layer.effect(Store, Effect.map(Database, makeStore));
