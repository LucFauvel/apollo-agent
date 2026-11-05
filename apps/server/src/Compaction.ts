import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SessionId, StorageReport } from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { ServerConfig, type StoragePolicy } from "./Config.ts";
import { Database } from "./Database.ts";
import { SessionManager } from "./SessionManager.ts";

/**
 * Keeps the database bounded. Ordinary passes only remove what has stopped
 * being useful; when the database is over budget, older history is thinned
 * in steps until it fits. Memories, core memory and active skills are never
 * removed to meet the budget: the archive has its own count limit.
 *
 * 1. Tool output and reasoning older than the retention window are trimmed.
 * 2. Finished reflection sessions (one-shot, they copy a transcript) are deleted.
 * 3. Archive memories over the per-scope limit are evicted, least recently used first.
 * 4. Only the newest archived versions of each skill are kept.
 * 5. Over budget: drop tool events entirely (older than a week, a day, then all),
 *    then delete the least recently active idle worker sessions.
 * 6. Freed pages go back to the OS (incremental vacuum + WAL truncate).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Excerpt kept from trimmed tool output and reasoning. */
const TRIM_TO = 300;
const REFLECTION_RETENTION_MS = DAY_MS;
const SKILL_VERSIONS_KEPT = 5;
const DETAIL_TAGS = "('ToolStarted', 'ToolCompleted', 'Reasoning')";

export interface CompactionResult {
  readonly trimmedEvents: number;
  readonly droppedEvents: number;
  readonly evictedMemories: number;
  readonly deletedSkillVersions: number;
  readonly deletedSessions: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

/** Bytes in use: pages minus the free list. */
export const usedBytes = (db: DatabaseSync): number => {
  const pragma = (name: string) => Number(Object.values(db.prepare(`pragma ${name}`).get() ?? {})[0] ?? 0);
  return (pragma("page_count") - pragma("freelist_count")) * pragma("page_size");
};

const changes = (db: DatabaseSync, sql: string, ...params: Array<SQLInputValue>) =>
  Number(db.prepare(sql).run(...params).changes);

/** Steps 1-4: housekeeping that runs on every pass. */
export const tidy = (db: DatabaseSync, policy: StoragePolicy, now: number) => {
  const cutoff = now - policy.detailRetentionMs;
  const trimmedEvents =
    changes(
      db,
      `update session_events
       set event = json_set(event, '$.output', substr(json_extract(event, '$.output'), 1, ${TRIM_TO}) || '…')
       where at < ? and json_extract(event, '$._tag') = 'ToolCompleted'
         and length(json_extract(event, '$.output')) > ${TRIM_TO + 100}`,
      cutoff,
    ) +
    changes(
      db,
      `update session_events
       set event = json_set(event, '$.text', substr(json_extract(event, '$.text'), 1, ${TRIM_TO}) || '…')
       where at < ? and json_extract(event, '$._tag') = 'Reasoning'
         and length(json_extract(event, '$.text')) > ${TRIM_TO + 100}`,
      cutoff,
    );

  let evictedMemories = 0;
  const scopes = db
    .prepare("select coalesce(bot_id, '') as scope, count(*) as n from memories group by 1 having n > ?")
    .all(policy.archiveLimit) as Array<{ scope: string; n: number }>;
  for (const { scope } of scopes) {
    evictedMemories += changes(
      db,
      `delete from memories where id in (
         select id from memories where coalesce(bot_id, '') = ?
         order by coalesce(last_used_at, created_at) desc limit -1 offset ?)`,
      scope,
      policy.archiveLimit,
    );
  }

  const deletedSkillVersions = changes(
    db,
    `delete from skills where id in (
       select id from (
         select id, row_number() over (partition by coalesce(bot_id, ''), name order by version desc) as rank
         from skills where status = 'archived')
       where rank > ?)`,
    SKILL_VERSIONS_KEPT,
  );

  return { trimmedEvents, evictedMemories, deletedSkillVersions };
};

/** Step 5a: drops tool events older than `before`. */
export const dropDetail = (db: DatabaseSync, before: number) =>
  changes(
    db,
    `delete from session_events where at < ? and json_extract(event, '$._tag') in ${DETAIL_TAGS}`,
    before,
  );

/** Step 6: returns freed pages to the OS. */
export const reclaim = (db: DatabaseSync) => {
  db.exec("pragma incremental_vacuum");
  db.exec("pragma wal_checkpoint(truncate)");
};

const fileBytes = (db: DatabaseSync) => {
  const pragma = (name: string) => Number(Object.values(db.prepare(`pragma ${name}`).get() ?? {})[0] ?? 0);
  return pragma("page_count") * pragma("page_size");
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const db = yield* Database;
  const config = yield* ServerConfig;
  const manager = yield* SessionManager;
  const policy = config.storage;
  let lastCompactedAt: number | null = null;

  const count = (sql: string) => Number(Object.values(db.prepare(sql).get() ?? {})[0] ?? 0);

  const report = Effect.sync(
    (): StorageReport => ({
      databaseBytes: fileBytes(db),
      budgetBytes: policy.budgetBytes,
      memories: count("select count(*) from memories"),
      sessions: count("select count(*) from sessions"),
      events: count("select count(*) from session_events"),
      lastCompactedAt,
    }),
  );

  /** Sessions safe to delete: idle (not live) reflections or workers, least recently active first. */
  const deletable = (where: string, ...params: Array<SQLInputValue>) =>
    Effect.gen(function* () {
      const rows = db
        .prepare(`select id from sessions where ${where} order by updated_at`)
        .all(...params) as Array<{ id: SessionId }>;
      const ids: Array<SessionId> = [];
      for (const { id } of rows) if (!(yield* manager.isLive(id))) ids.push(id);
      return ids;
    });

  const deleteSessions = (ids: ReadonlyArray<SessionId>) =>
    Effect.forEach(ids, (id) => manager.deleteSession(id).pipe(Effect.ignore), { discard: true }).pipe(
      Effect.as(ids.length),
    );

  const compact = Effect.gen(function* () {
    const now = Date.now();
    const bytesBefore = fileBytes(db);
    const tidied = yield* Effect.sync(() => tidy(db, policy, now));

    let deletedSessions = yield* deleteSessions(
      yield* deletable(
        "role = 'reflection' and status in ('idle', 'error', 'closed') and updated_at < ?",
        now - REFLECTION_RETENTION_MS,
      ),
    );

    let droppedEvents = 0;
    for (const age of [7 * DAY_MS, DAY_MS, 0]) {
      if (usedBytes(db) <= policy.budgetBytes) break;
      droppedEvents += yield* Effect.sync(() => dropDetail(db, now - age));
    }
    if (usedBytes(db) > policy.budgetBytes) {
      const workers = yield* deletable("role = 'worker' and status in ('idle', 'error', 'closed')");
      for (let i = 0; i < workers.length && usedBytes(db) > policy.budgetBytes; i += 10) {
        deletedSessions += yield* deleteSessions(workers.slice(i, i + 10));
      }
    }
    if (usedBytes(db) > policy.budgetBytes) {
      yield* Effect.logWarning(
        `Apollo's database (${Math.round(usedBytes(db) / 1e6)} MB) is still over its ${Math.round(policy.budgetBytes / 1e6)} MB budget: what is left is conversation messages, memory and skills. Raise APOLLO_MAX_STORAGE_MB or delete bots you no longer need.`,
      );
    }

    yield* Effect.sync(() => reclaim(db));
    lastCompactedAt = now;
    if (tidied.evictedMemories > 0) yield* manager.publishMemoryChanged(null);
    if (tidied.deletedSkillVersions > 0) yield* manager.publishSkillChanged(null);

    const result: CompactionResult = {
      ...tidied,
      droppedEvents,
      deletedSessions,
      bytesBefore,
      bytesAfter: fileBytes(db),
    };
    const removed =
      result.trimmedEvents + result.droppedEvents + result.evictedMemories + result.deletedSkillVersions + result.deletedSessions;
    if (removed > 0 || result.bytesAfter < result.bytesBefore) {
      yield* Effect.logInfo("compacted storage", result);
    }
    return result;
  });

  // Shortly after startup, then every six hours.
  yield* compact.pipe(
    Effect.catchCause((cause) => Effect.logError("storage compaction failed", cause)),
    Effect.delay(Duration.minutes(1)),
    Effect.repeat(Schedule.spaced(Duration.hours(6))),
    Effect.forkScoped,
  );

  return {
    report,
    compact: compact.pipe(Effect.andThen(report)),
  };
});

export class Compaction extends Context.Service<Compaction, Effect.Success<typeof make>>()(
  "apollo/Compaction",
) {}

export const layer = Layer.effect(Compaction, make);
