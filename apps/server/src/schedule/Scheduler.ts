import type { SQLInputValue } from "node:sqlite";
import {
  ApolloError,
  type Bot,
  type BotId,
  type CreateScheduleInput,
  type ProviderKind,
  type Schedule,
  type ScheduleId,
  type SchedulePreview,
  type ScheduleRun,
  type ScheduleRunStatus,
  type SessionId,
  type UpdateScheduleInput,
} from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Database } from "../Database.ts";
import { SessionManager } from "../SessionManager.ts";
import { newId, Store } from "../Store.ts";
import {
  graceMs,
  MIN_INTERVAL_MS,
  nextRun,
  parseSpec,
  shortestGap,
  type Spec,
  systemTimeZone,
  upcoming,
} from "./Spec.ts";

/** Schedules the orchestrator may have at once. */
const MAX_BOT_SCHEDULES = 20;
/** Failed runs in a row before a schedule turns itself off. */
const MAX_FAILURE_STREAK = 3;
/** Task sessions kept per schedule; older ones are deleted. Run history outlives them. */
const KEEP_RUN_SESSIONS = 5;
const KEEP_RUNS = 50;

export const SILENT = "[SILENT]";
const isSilent = (message: string | null) => message === null || message.trim() === "" || message.includes(SILENT);

const invalid = (message: string) => new ApolloError({ code: "invalid", message });
const notFound = (id: ScheduleId) => new ApolloError({ code: "not_found", message: `schedule ${id} not found` });

type Row = Record<string, SQLInputValue>;

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const toSchedule = (r: Row): Schedule => {
  const parsed = parseSpec(r.spec as string, r.timezone as string, Number(r.created_at));
  return {
    id: r.id as ScheduleId,
    botId: r.bot_id as BotId,
    kind: r.kind as Schedule["kind"],
    name: r.name as string,
    prompt: r.prompt as string,
    spec: r.spec as string,
    description: parsed.ok ? parsed.spec.description : (r.spec as string),
    timezone: r.timezone as string,
    provider: r.provider
      ? {
          provider: r.provider as ProviderKind,
          ...(r.model ? { model: r.model as string } : {}),
          ...(r.effort ? { effort: r.effort as string } : {}),
        }
      : null,
    cwd: (r.cwd as string | null) ?? null,
    enabled: r.enabled === 1,
    createdBy: r.created_by as Schedule["createdBy"],
    nextRunAt: r.next_run_at === null ? null : Number(r.next_run_at),
    lastRunAt: r.last_run_at === null ? null : Number(r.last_run_at),
    lastStatus: (r.last_status as ScheduleRunStatus | null) ?? null,
    failureStreak: Number(r.failure_streak),
    runCount: Number(r.run_count),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
};

const toRun = (r: Row): ScheduleRun => ({
  id: r.id as string,
  scheduleId: r.schedule_id as ScheduleId,
  sessionId: (r.session_id as SessionId | null) ?? null,
  startedAt: Number(r.started_at),
  finishedAt: r.finished_at === null ? null : Number(r.finished_at),
  status: r.status as ScheduleRunStatus,
  summary: (r.summary as string | null) ?? null,
});

/** The first run of a schedule created or changed at `now`. */
const firstRun = (spec: Spec, now: number) =>
  spec.kind === "interval" ? now + spec.everyMs : nextRun(spec, now, now);

/** The prompt a scheduled task's worker session receives. */
export const taskPrompt = (schedule: Schedule) =>
  [
    schedule.prompt.trim(),
    "",
    "---",
    [
      `[Apollo] This is a scheduled task ("${schedule.name}", ${schedule.description.toLowerCase()}). It runs unattended:`,
      "nobody can answer questions, so make reasonable assumptions and finish the job. Your final message is",
      `delivered to the user. If there is nothing worth reporting this time, reply with exactly ${SILENT}.`,
    ].join(" "),
  ].join("\n");

/** The message a heartbeat sends into the orchestrator's conversation. */
export const heartbeatPrompt = (schedule: Schedule) =>
  [
    `[Apollo heartbeat "${schedule.name}"] ${schedule.prompt.trim()}`,
    "",
    `(This check-in runs on a schedule: ${schedule.description.toLowerCase()}. If there is nothing worth telling the user ` +
      `right now, reply with exactly ${SILENT}.)`,
  ].join("\n");

export interface SchedulerOptions {
  /** How often due schedules are checked; `null` disables the loop (tests call `tick`). */
  readonly tickEvery: Duration.Input | null;
  /** A task run that has not finished by then is interrupted and counts as failed. */
  readonly taskTimeout: Duration.Input;
  readonly heartbeatTimeout: Duration.Input;
  /** How long after startup the loop first checks (default 5 s). */
  readonly startDelay?: Duration.Input;
}

type Outcome = { readonly ok: true; readonly message: string | null } | { readonly ok: false; readonly error: string };

const make = (options: SchedulerOptions) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const store = yield* Store;
    const manager = yield* SessionManager;
    const scope = yield* Effect.scope;

    const all = (sql: string, ...params: Array<SQLInputValue>) => db.prepare(sql).all(...params) as Array<Row>;
    const get = (sql: string, ...params: Array<SQLInputValue>) => db.prepare(sql).get(...params) as Row | undefined;
    const run = (sql: string, ...params: Array<SQLInputValue>) => db.prepare(sql).run(...params);

    /** Schedules with a run in progress. */
    const running = new Set<ScheduleId>();
    /** Orchestrator sessions whose current turn a schedule started. */
    const scheduledTurns = new Set<SessionId>();
    /** Why a due schedule could not start yet; reported if it ends up skipped. */
    const blocked = new Map<ScheduleId, string>();

    const getSchedule = (id: ScheduleId) =>
      Effect.suspend(() => {
        const row = get("select * from schedules where id = ?", id);
        return row ? Effect.succeed(toSchedule(row)) : Effect.fail(notFound(id));
      });

    const publishSchedule = (id: ScheduleId) =>
      Effect.gen(function* () {
        const schedule = yield* Effect.option(getSchedule(id));
        if (Option.isSome(schedule)) yield* manager.publish({ _tag: "ScheduleUpserted", schedule: schedule.value });
      });

    const background = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logWarning("scheduled run failed", cause)),
        Effect.forkIn(scope),
        Effect.asVoid,
      );

    // --- validation ----------------------------------------------------------

    const checkSpec = (text: string, timezone: string, now: number) =>
      Effect.gen(function* () {
        const parsed = parseSpec(text, timezone, now);
        if (!parsed.ok) return yield* invalid(parsed.error);
        const spec = parsed.spec;
        if (spec.kind === "once" && spec.at <= now) return yield* invalid(`${spec.description} has already passed`);
        const gap = shortestGap(spec, now);
        if (gap !== null && gap < MIN_INTERVAL_MS) {
          return yield* invalid("schedules may not run more often than every 5 minutes");
        }
        return spec;
      });

    const checkText = (name: string, prompt: string) =>
      Effect.gen(function* () {
        if (name.trim().length === 0) return yield* invalid("give the schedule a name");
        if (prompt.trim().length === 0) return yield* invalid("say what the schedule should do (its prompt)");
      });

    // --- runs ------------------------------------------------------------------

    /** Waits for the session's turn to end and reads what it said after `afterSeq`. */
    const awaitTurn = (id: SessionId, afterSeq: number, timeout: Duration.Input) =>
      Effect.gen(function* () {
        const { timedOut } = yield* manager.waitUntilIdle(id, timeout);
        if (timedOut) {
          yield* manager.interrupt(id).pipe(Effect.ignore);
          return { ok: false, error: `it took longer than ${Duration.format(Duration.fromInputUnsafe(timeout))}` } as Outcome;
        }
        const events = (yield* store.listEvents(id, afterSeq)).map((e) => e.event);
        const completed = events.findLast((e) => e._tag === "TurnCompleted");
        if (!completed) {
          const notice = events.findLast((e) => e._tag === "Notice" && e.level === "error");
          return {
            ok: false,
            error: notice?._tag === "Notice" ? notice.message : "the session stopped before finishing its turn",
          } as Outcome;
        }
        if (completed.outcome !== "completed") {
          return { ok: false, error: completed.error ?? `the turn was ${completed.outcome}` } as Outcome;
        }
        const message = events.findLast((e) => e._tag === "AssistantMessage");
        return { ok: true, message: message?._tag === "AssistantMessage" ? message.text : null } as Outcome;
      });

    /** Sends a schedule's message to the orchestrator; the turn it starts may not create schedules. */
    const sendToMain = (bot: Bot, text: string) =>
      Effect.gen(function* () {
        const main = bot.mainSessionId;
        // A scheduled turn is a fresh start, not the tail of a runaway loop.
        yield* manager.resetAutonomy(bot.id);
        scheduledTurns.add(main);
        yield* manager.send(main, text, "system").pipe(Effect.onError(() => Effect.sync(() => scheduledTurns.delete(main))));
      });

    const releaseTurn = (main: SessionId) =>
      manager.waitUntilIdle(main, Duration.hours(2)).pipe(
        Effect.ensuring(Effect.sync(() => scheduledTurns.delete(main))),
        Effect.ignore,
      );

    const notify = (bot: Bot, sessionId: SessionId | null, title: string, body: string) =>
      manager.publish({ _tag: "Notify", botId: bot.id, sessionId, title, body: truncate(body.trim(), 280) });

    const finishRun = (runId: string, schedule: Schedule, status: ScheduleRunStatus, summary: string | null) =>
      Effect.sync(() => {
        const now = Date.now();
        run("update schedule_runs set status = ?, summary = ?, finished_at = ? where id = ?", status, summary, now, runId);
        run(
          `update schedules set last_status = ?, run_count = run_count + 1, updated_at = ?,
             failure_streak = case when ? = 'failed' then failure_streak + 1 else 0 end
           where id = ?`,
          status,
          now,
          status,
          schedule.id,
        );
      });

    /** Drops old task sessions and run history. */
    const prune = (schedule: Schedule) =>
      Effect.gen(function* () {
        if (schedule.kind === "task") {
          const old = all(
            `select session_id from schedule_runs where schedule_id = ? and session_id is not null
             order by started_at desc limit -1 offset ?`,
            schedule.id,
            KEEP_RUN_SESSIONS,
          );
          for (const row of old) {
            const id = row.session_id as SessionId;
            const session = yield* Effect.option(store.getSession(id));
            if (Option.isSome(session) && session.value.role === "worker") {
              yield* manager.deleteSession(id).pipe(Effect.ignore);
            }
          }
        }
        run(
          `delete from schedule_runs where schedule_id = ? and id not in
             (select id from schedule_runs where schedule_id = ? order by started_at desc limit ?)`,
          schedule.id,
          schedule.id,
          KEEP_RUNS,
        );
      });

    const onFailure = (bot: Bot, schedule: Schedule, sessionId: SessionId | null, error: string) =>
      Effect.gen(function* () {
        const label = schedule.kind === "task" ? "Scheduled task" : "Heartbeat";
        yield* manager.appendNotice(bot.mainSessionId, "warning", `${label} "${schedule.name}" failed: ${error}`);
        const current = yield* getSchedule(schedule.id);
        if (current.failureStreak >= MAX_FAILURE_STREAK && current.enabled) {
          run("update schedules set enabled = 0, next_run_at = null, updated_at = ? where id = ?", Date.now(), schedule.id);
          yield* manager.appendNotice(
            bot.mainSessionId,
            "warning",
            `${label} "${schedule.name}" failed ${MAX_FAILURE_STREAK} times in a row and was turned off.`,
          );
          yield* notify(bot, sessionId, `${bot.name}: "${schedule.name}" turned off`, `It failed ${MAX_FAILURE_STREAK} times in a row. Last error: ${error}`);
        } else {
          yield* notify(bot, sessionId, `${bot.name}: "${schedule.name}" failed`, error);
        }
      });

    const executeTask = (bot: Bot, schedule: Schedule, runId: string) =>
      Effect.gen(function* () {
        const created = yield* manager
          .createSession({
            botId: bot.id,
            title: `⏱ ${schedule.name}`,
            provider: schedule.provider ?? bot.defaultWorker,
            cwd: schedule.cwd ?? undefined,
            prompt: taskPrompt(schedule),
            parentSessionId: bot.mainSessionId,
            notifyParent: false,
            author: "system",
          })
          .pipe(Effect.result);
        if (created._tag === "Failure") {
          yield* finishRun(runId, schedule, "failed", created.failure.message);
          return yield* onFailure(bot, schedule, null, created.failure.message);
        }
        const session = created.success;
        run("update schedule_runs set session_id = ? where id = ?", session.id, runId);
        const outcome = yield* awaitTurn(session.id, 0, options.taskTimeout);
        if (!outcome.ok) {
          yield* finishRun(runId, schedule, "failed", outcome.error);
          return yield* onFailure(bot, schedule, session.id, outcome.error);
        }
        if (isSilent(outcome.message)) return yield* finishRun(runId, schedule, "silent", outcome.message);

        const report = outcome.message!;
        yield* finishRun(runId, schedule, "delivered", report);
        yield* notify(bot, session.id, `${bot.name}: ${schedule.name}`, report);
        const delivered = yield* sendToMain(
          bot,
          [
            `[Apollo] Scheduled task "${schedule.name}" (${schedule.description.toLowerCase()}) finished in session ${session.id}. Its report:`,
            "",
            report,
            "",
            "The user was notified. Pass on what matters to them, or follow up if the report needs action.",
          ].join("\n"),
        ).pipe(Effect.result);
        if (delivered._tag === "Failure") {
          yield* manager.appendNotice(
            bot.mainSessionId,
            "warning",
            `Scheduled task "${schedule.name}" finished but was not delivered to the orchestrator: ${delivered.failure.message}`,
          );
        } else {
          yield* background(releaseTurn(bot.mainSessionId));
        }
      });

    const executeHeartbeat = (bot: Bot, schedule: Schedule, runId: string) =>
      Effect.gen(function* () {
        const main = bot.mainSessionId;
        run("update schedule_runs set session_id = ? where id = ?", main, runId);
        const afterSeq = yield* store.latestSeq(main);
        const sent = yield* sendToMain(bot, heartbeatPrompt(schedule)).pipe(Effect.result);
        if (sent._tag === "Failure") {
          yield* finishRun(runId, schedule, "failed", sent.failure.message);
          return yield* onFailure(bot, schedule, main, sent.failure.message);
        }
        const outcome = yield* awaitTurn(main, afterSeq, options.heartbeatTimeout).pipe(
          Effect.ensuring(Effect.sync(() => scheduledTurns.delete(main))),
        );
        if (!outcome.ok) {
          yield* finishRun(runId, schedule, "failed", outcome.error);
          return yield* onFailure(bot, schedule, main, outcome.error);
        }
        if (isSilent(outcome.message)) return yield* finishRun(runId, schedule, "silent", outcome.message);
        yield* finishRun(runId, schedule, "delivered", outcome.message);
        yield* notify(bot, main, `${bot.name}: ${schedule.name}`, outcome.message!);
      });

    /** Starts a run in the background. */
    const start = (schedule: Schedule, bot: Bot) =>
      Effect.gen(function* () {
        running.add(schedule.id);
        const runId = newId<string>("run");
        const now = Date.now();
        run(
          "insert into schedule_runs (id, schedule_id, session_id, started_at, status) values (?, ?, null, ?, 'running')",
          runId,
          schedule.id,
          now,
        );
        run("update schedules set last_status = 'running', last_run_at = ?, updated_at = ? where id = ?", now, now, schedule.id);
        yield* publishSchedule(schedule.id);
        const execute = schedule.kind === "task" ? executeTask(bot, schedule, runId) : executeHeartbeat(bot, schedule, runId);
        yield* background(
          execute.pipe(
            Effect.catchCause((cause) =>
              finishRun(runId, schedule, "failed", "Apollo hit an internal error").pipe(
                Effect.andThen(Effect.logError("scheduled run crashed", cause)),
              ),
            ),
            Effect.andThen(prune(schedule)),
            Effect.ensuring(
              Effect.suspend(() => {
                running.delete(schedule.id);
                return publishSchedule(schedule.id);
              }),
            ),
          ),
        );
      });

    /** Why the schedule cannot start now, or `null` when it can. */
    const blockedReason = (schedule: Schedule, bot: Bot) =>
      Effect.gen(function* () {
        if (running.has(schedule.id)) return "its previous run was still going";
        if (bot.pausedReason !== null) return `${bot.name} was paused (${bot.pausedReason})`;
        if (schedule.kind === "heartbeat") {
          return (yield* manager.isBusy(bot.mainSessionId)) ? "the orchestrator was busy" : null;
        }
        const workers = yield* manager.busyWorkers(bot.id);
        return workers >= bot.limits.maxConcurrentWorkers ? `all ${bot.limits.maxConcurrentWorkers} worker slots were busy` : null;
      });

    /** Moves a schedule past the run that was due; one-shots turn off. */
    const advance = (schedule: Schedule, spec: Spec, due: number, now: number) =>
      Effect.sync(() => {
        const next = spec.kind === "once" ? null : nextRun(spec, now, due);
        run(
          "update schedules set next_run_at = ?, enabled = ?, updated_at = ? where id = ?",
          next,
          next === null ? 0 : 1,
          now,
          schedule.id,
        );
      });

    const recordSkipped = (schedule: Schedule, reason: string, now: number) =>
      Effect.sync(() => {
        run(
          `insert into schedule_runs (id, schedule_id, session_id, started_at, finished_at, status, summary)
           values (?, ?, null, ?, ?, 'skipped', ?)`,
          newId<string>("run"),
          schedule.id,
          now,
          now,
          reason,
        );
        run("update schedules set last_status = 'skipped', updated_at = ? where id = ?", now, schedule.id);
      });

    /** Starts every due schedule that can run; skips those that missed their window. */
    const tick = (now = Date.now()) =>
      Effect.gen(function* () {
        const due = all(
          "select * from schedules where enabled = 1 and next_run_at is not null and next_run_at <= ? order by next_run_at",
          now,
        ).map(toSchedule);
        for (const schedule of due) {
          const dueAt = schedule.nextRunAt!;
          const parsed = parseSpec(schedule.spec, schedule.timezone, schedule.createdAt);
          if (!parsed.ok) {
            run("update schedules set enabled = 0, next_run_at = null where id = ?", schedule.id);
            yield* publishSchedule(schedule.id);
            continue;
          }
          const bot = yield* Effect.option(store.getBot(schedule.botId));
          if (Option.isNone(bot)) continue;
          const late = now - dueAt > graceMs(parsed.spec, dueAt);
          const reason = yield* blockedReason(schedule, bot.value);
          if (reason !== null && !late) {
            blocked.set(schedule.id, reason);
            continue;
          }
          if (late) {
            const why =
              reason ??
              blocked.get(schedule.id) ??
              `Apollo was not running at ${new Date(dueAt).toLocaleString("en-US", { timeZone: schedule.timezone })}`;
            blocked.delete(schedule.id);
            yield* recordSkipped(schedule, `Skipped: ${why}.`, now);
            yield* advance(schedule, parsed.spec, dueAt, now);
            yield* publishSchedule(schedule.id);
            continue;
          }
          blocked.delete(schedule.id);
          yield* advance(schedule, parsed.spec, dueAt, now);
          yield* start(yield* getSchedule(schedule.id), bot.value);
        }
      });

    // --- startup -------------------------------------------------------------------

    // Runs cut short by a restart cannot be resumed: their turn died with the old process.
    yield* Effect.sync(() => {
      const now = Date.now();
      run(
        "update schedule_runs set status = 'failed', finished_at = ?, summary = 'Apollo stopped before the run finished' where status = 'running'",
        now,
      );
      run("update schedules set last_status = 'failed' where last_status = 'running'");
    });

    if (options.tickEvery !== null) {
      const every = options.tickEvery;
      yield* Effect.sleep(options.startDelay ?? Duration.seconds(5)).pipe(
        Effect.andThen(
          Effect.forever(
            // Suspended so each check reads the clock anew: `tick()` alone would build one effect
            // whose `now` is frozen at startup, and nothing due after that would ever run.
            Effect.suspend(() => tick()).pipe(
              Effect.catchCause((cause) => Effect.logWarning("scheduler tick failed", cause)),
              Effect.andThen(Effect.sleep(every)),
            ),
          ),
        ),
        Effect.forkIn(scope),
      );
    }

    // --- API ----------------------------------------------------------------------------

    return {
      tick,

      /** Whether the session is in a turn a schedule started: such turns may not create schedules. */
      isScheduledTurn: (sessionId: SessionId) => Effect.sync(() => scheduledTurns.has(sessionId)),

      list: (botId?: BotId) =>
        Effect.sync(() =>
          (botId
            ? all("select * from schedules where bot_id = ? order by created_at", botId)
            : all("select * from schedules order by created_at")
          ).map(toSchedule),
        ),

      get: getSchedule,

      runs: (id: ScheduleId) =>
        Effect.gen(function* () {
          yield* getSchedule(id);
          return all("select * from schedule_runs where schedule_id = ? order by started_at desc limit 30", id).map(toRun);
        }),

      preview: (text: string, timezone?: string) =>
        Effect.gen(function* () {
          const tz = timezone?.trim() || systemTimeZone();
          const now = Date.now();
          const spec = yield* checkSpec(text, tz, now);
          return {
            spec: spec.spec,
            description: spec.description,
            timezone: tz,
            nextRuns: upcoming(spec, now, 5),
          } satisfies SchedulePreview;
        }),

      create: (input: CreateScheduleInput, createdBy: Schedule["createdBy"]) =>
        Effect.gen(function* () {
          const bot = yield* store.getBot(input.botId);
          yield* checkText(input.name, input.prompt);
          const timezone = input.timezone?.trim() || systemTimeZone();
          const now = Date.now();
          const spec = yield* checkSpec(input.spec, timezone, now);
          if (createdBy === "bot") {
            const count = Number(get("select count(*) as n from schedules where bot_id = ?", bot.id)?.n ?? 0);
            if (count >= MAX_BOT_SCHEDULES) {
              return yield* invalid(`${bot.name} already has ${count} schedules; remove one first`);
            }
          }
          const enabled = input.enabled ?? true;
          const provider = input.kind === "task" ? (input.provider ?? null) : null;
          const id = newId<ScheduleId>("sch");
          run(
            `insert into schedules (id, bot_id, kind, name, prompt, spec, timezone, provider, model, effort, cwd,
               enabled, created_by, next_run_at, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            bot.id,
            input.kind,
            input.name.trim(),
            input.prompt.trim(),
            spec.spec,
            timezone,
            provider?.provider ?? null,
            provider?.model ?? null,
            provider?.effort ?? null,
            input.kind === "task" ? input.cwd?.trim() || null : null,
            enabled ? 1 : 0,
            createdBy,
            enabled ? firstRun(spec, now) : null,
            now,
            now,
          );
          const schedule = yield* getSchedule(id);
          yield* manager.publish({ _tag: "ScheduleUpserted", schedule });
          return schedule;
        }),

      update: (input: UpdateScheduleInput) =>
        Effect.gen(function* () {
          const current = yield* getSchedule(input.scheduleId);
          const name = input.name ?? current.name;
          const prompt = input.prompt ?? current.prompt;
          yield* checkText(name, prompt);
          const timezone = input.timezone?.trim() || current.timezone;
          const now = Date.now();
          const specChanged = (input.spec !== undefined && input.spec !== current.spec) || timezone !== current.timezone;
          const enabled = input.enabled ?? current.enabled;
          const turnedOn = enabled && !current.enabled;
          // A one-shot that already ran keeps its spec only while it stays off.
          const spec =
            specChanged || turnedOn
              ? yield* checkSpec(input.spec ?? current.spec, timezone, now)
              : null;
          const provider =
            current.kind === "task" ? (input.provider !== undefined ? input.provider : current.provider) : null;
          const cwd = current.kind === "task" ? (input.cwd !== undefined ? input.cwd?.trim() || null : current.cwd) : null;
          const nextRunAt = !enabled ? null : spec !== null ? firstRun(spec, now) : current.nextRunAt;
          run(
            `update schedules set name = ?, prompt = ?, spec = ?, timezone = ?, provider = ?, model = ?, effort = ?,
               cwd = ?, enabled = ?, next_run_at = ?, failure_streak = ?, updated_at = ? where id = ?`,
            name.trim(),
            prompt.trim(),
            spec?.spec ?? current.spec,
            timezone,
            provider?.provider ?? null,
            provider?.model ?? null,
            provider?.effort ?? null,
            cwd,
            enabled ? 1 : 0,
            nextRunAt,
            turnedOn ? 0 : current.failureStreak,
            now,
            current.id,
          );
          blocked.delete(current.id);
          const schedule = yield* getSchedule(current.id);
          yield* manager.publish({ _tag: "ScheduleUpserted", schedule });
          return schedule;
        }),

      remove: (id: ScheduleId) =>
        Effect.gen(function* () {
          const schedule = yield* getSchedule(id);
          run("delete from schedules where id = ?", id);
          blocked.delete(id);
          yield* manager.publish({ _tag: "ScheduleDeleted", scheduleId: id, botId: schedule.botId });
        }),

      /** Starts a run now, outside the schedule; the schedule's next run stays as it was. */
      runNow: (id: ScheduleId) =>
        Effect.gen(function* () {
          const schedule = yield* getSchedule(id);
          const bot = yield* store.getBot(schedule.botId);
          const reason = yield* blockedReason(schedule, bot);
          if (reason !== null) return yield* invalid(`cannot run "${schedule.name}" now: ${reason.replace(" was ", " is ").replace(" were ", " are ")}`);
          yield* start(schedule, bot);
        }),
    };
  });

export class Scheduler extends Context.Service<Scheduler, Effect.Success<ReturnType<typeof make>>>()(
  "apollo/Scheduler",
) {}

export const layerWith = (options: SchedulerOptions) => Layer.effect(Scheduler, make(options));

export const layer = layerWith({
  tickEvery: Duration.seconds(30),
  taskTimeout: Duration.hours(1),
  heartbeatTimeout: Duration.minutes(30),
});
