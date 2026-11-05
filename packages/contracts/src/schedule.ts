import * as Schema from "effect/Schema";
import { BotId, ProviderSelection, SessionId, Timestamp } from "./domain.ts";

export const ScheduleId = Schema.String.pipe(Schema.brand("ScheduleId"));
export type ScheduleId = typeof ScheduleId.Type;

/**
 * - `task`: runs its prompt in a fresh worker session, then delivers the result
 *   to the orchestrator. For self-contained jobs ("summarize my inbox").
 * - `heartbeat`: sends its prompt to the orchestrator's own conversation, so it
 *   can use everything the orchestrator knows ("check on the workers").
 */
export const ScheduleKind = Schema.Literals(["task", "heartbeat"]);
export type ScheduleKind = typeof ScheduleKind.Type;

/**
 * - `delivered`: the run had something to say; it reached the orchestrator and a notification.
 * - `silent`: the run answered `[SILENT]`: nothing worth telling the user.
 * - `skipped`: the run did not start (the bot was paused or busy, or Apollo was not running).
 */
export const ScheduleRunStatus = Schema.Literals(["running", "delivered", "silent", "failed", "skipped"]);
export type ScheduleRunStatus = typeof ScheduleRunStatus.Type;

export const Schedule = Schema.Struct({
  id: ScheduleId,
  botId: BotId,
  kind: ScheduleKind,
  name: Schema.String,
  prompt: Schema.String,
  /** When it runs, as written: "every 30m", "weekdays at 9am", "0 9 * * 1-5", "2026-11-05 09:00". */
  spec: Schema.String,
  /** `spec` in plain words. */
  description: Schema.String,
  /** IANA time zone the spec's wall-clock times are read in. */
  timezone: Schema.String,
  /** Provider for task runs; `null` uses the bot's default worker. Heartbeats use the orchestrator. */
  provider: Schema.NullOr(ProviderSelection),
  /** Working directory for task runs; `null` uses the bot's. */
  cwd: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  /** Who made it: the user, or the bot's orchestrator. */
  createdBy: Schema.Literals(["user", "bot"]),
  /** `null` when disabled or a one-shot that already ran. */
  nextRunAt: Schema.NullOr(Timestamp),
  lastRunAt: Schema.NullOr(Timestamp),
  lastStatus: Schema.NullOr(ScheduleRunStatus),
  /** Failed runs in a row; the schedule turns itself off at three. */
  failureStreak: Schema.Number,
  runCount: Schema.Number,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Schedule = typeof Schedule.Type;

export const ScheduleRun = Schema.Struct({
  id: Schema.String,
  scheduleId: ScheduleId,
  /** The task's worker session (or the orchestrator, for heartbeats); `null` once cleaned up. */
  sessionId: Schema.NullOr(SessionId),
  startedAt: Timestamp,
  finishedAt: Schema.NullOr(Timestamp),
  status: ScheduleRunStatus,
  /** What it reported, why it failed, or why it was skipped. */
  summary: Schema.NullOr(Schema.String),
});
export type ScheduleRun = typeof ScheduleRun.Type;

export const CreateScheduleInput = Schema.Struct({
  botId: BotId,
  kind: ScheduleKind,
  name: Schema.String,
  prompt: Schema.String,
  spec: Schema.String,
  /** Defaults to the server's time zone. */
  timezone: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.NullOr(ProviderSelection)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
});
export type CreateScheduleInput = typeof CreateScheduleInput.Type;

/** Omitted fields stay as they are. */
export const UpdateScheduleInput = Schema.Struct({
  scheduleId: ScheduleId,
  name: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  spec: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.NullOr(ProviderSelection)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
});
export type UpdateScheduleInput = typeof UpdateScheduleInput.Type;

/** How a spec reads, and when it would run next. */
export const SchedulePreview = Schema.Struct({
  spec: Schema.String,
  description: Schema.String,
  timezone: Schema.String,
  nextRuns: Schema.Array(Timestamp),
});
export type SchedulePreview = typeof SchedulePreview.Type;
