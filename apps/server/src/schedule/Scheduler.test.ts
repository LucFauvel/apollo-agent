import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type AppChange, DEFAULT_BOT_LIMITS, type ProviderKind, type ScheduleId } from "@apollo/contracts";
import type { Provider } from "@apollo/providers";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../Config.ts";
import * as Database from "../Database.ts";
import * as SessionManager from "../SessionManager.ts";
import * as Store from "../Store.ts";
import * as Scheduler from "./Scheduler.ts";

/**
 * Answers `echo: <text>`. A message containing "quiet" is answered `[SILENT]`,
 * "boom" fails the turn, and "slow" takes a while.
 */
const fakeProvider = (kind: ProviderKind): Provider => ({
  kind,
  listModels: Effect.succeed([]),
  open: (_options, emit) =>
    Effect.gen(function* () {
      const agent = (event: AgentEvent) => emit({ _tag: "Event", event });
      const scope = yield* Effect.scope;
      let n = 0;
      return {
        send: (text: string) =>
          Effect.gen(function* () {
            const itemId = `msg-${++n}`;
            yield* agent({ _tag: "TurnStarted" });
            if (text.includes("slow")) yield* Effect.sleep("400 millis");
            if (text.includes("boom")) {
              yield* agent({ _tag: "TurnCompleted", outcome: "failed", error: "it exploded" });
              return;
            }
            yield* agent({ _tag: "AssistantMessage", itemId, text: text.includes("quiet") ? "[SILENT]" : `echo: ${text.split("\n")[0]}` });
            yield* agent({ _tag: "TurnCompleted", outcome: "completed", error: null });
          }).pipe(Effect.forkIn(scope), Effect.asVoid),
        interrupt: Effect.void,
        respondApproval: () => Effect.void,
        respondInput: () => Effect.void,
        reloadSkills: Effect.void,
      };
    }),
});

const dataDir = mkdtempSync(join(tmpdir(), "apollo-scheduler-test-"));

const layer = Scheduler.layerWith({ tickEvery: null, taskTimeout: "5 seconds", heartbeatTimeout: "5 seconds" }).pipe(
  Layer.provideMerge(SessionManager.layer),
  Layer.provideMerge(
    Layer.succeed(SessionManager.Providers, {
      claude: fakeProvider("claude"),
      codex: fakeProvider("codex"),
      llamacpp: fakeProvider("llamacpp"),
    }),
  ),
  Layer.provideMerge(Store.layer),
  Layer.provideMerge(Database.layerMemory),
  Layer.provideMerge(
    Layer.succeed(ServerConfig, {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      webDistDir: null,
      baseUrl: "http://127.0.0.1:0",
      claudeExecutable: undefined,
      llamaCpp: { baseUrl: "http://127.0.0.1:8080", apiKey: null },
      codexExecutable: undefined,
      allowedOrigins: [],
      publicUrl: "http://127.0.0.1:0",
      desktopBootstrapToken: undefined,
      storage: { budgetBytes: 1e9, archiveLimit: 2000, detailRetentionMs: 30 * 86_400_000 },
    }),
  ),
);

const setup = Effect.gen(function* () {
  const manager = yield* SessionManager.SessionManager;
  const scheduler = yield* Scheduler.Scheduler;
  const store = yield* Store.Store;
  const bot = yield* manager.createBot({
    name: "Atlas",
    instructions: "",
    cwd: "/tmp",
    main: { provider: "claude" },
    defaultWorker: { provider: "codex" },
    runtimeMode: "full-access",
    autoLearn: false,
    limits: DEFAULT_BOT_LIMITS,
  });
  const changes: Array<AppChange> = [];
  yield* manager.changes.pipe(
    Stream.runForEach((change) => Effect.sync(() => void changes.push(change))),
    Effect.forkScoped,
  );
  yield* Effect.sleep("10 millis");
  const notifications = () => changes.filter((c) => c._tag === "Notify");
  /** Waits until the schedule has no run in progress, then returns its runs. */
  const settled = (id: ScheduleId) =>
    Effect.gen(function* () {
      for (let i = 0; i < 200; i++) {
        const schedule = yield* scheduler.get(id);
        if (schedule.lastStatus !== "running") {
          yield* Effect.sleep("20 millis");
          return yield* scheduler.runs(id);
        }
        yield* Effect.sleep("20 millis");
      }
      throw new Error("run did not finish");
    });
  const mainMessages = Effect.map(store.listEvents(bot.mainSessionId, 0), (events) =>
    events.flatMap((e) => (e.event._tag === "UserMessage" ? [e.event] : [])),
  );
  const mainNotices = Effect.map(store.listEvents(bot.mainSessionId, 0), (events) =>
    events.flatMap((e) => (e.event._tag === "Notice" ? [e.event.message] : [])),
  );
  return { manager, scheduler, store, bot, notifications, settled, mainMessages, mainNotices };
});

const MINUTE = 60_000;

describe("Scheduler", () => {
  it.live("runs a due task in a fresh worker and delivers its report to the orchestrator", () =>
    Effect.gen(function* () {
      const { scheduler, store, bot, notifications, settled, mainMessages } = yield* setup;
      const schedule = yield* scheduler.create(
        { botId: bot.id, kind: "task", name: "Digest", prompt: "Summarize the news", spec: "every 10m" },
        "user",
      );
      expect(schedule).toMatchObject({ enabled: true, description: "Every 10 minutes", createdBy: "user" });
      const due = schedule.nextRunAt!;

      // Not due yet: nothing happens.
      yield* scheduler.tick(due - 1000);
      expect((yield* scheduler.runs(schedule.id)).length).toBe(0);

      yield* scheduler.tick(due + 1000);
      const [run] = yield* settled(schedule.id);
      expect(run).toMatchObject({ status: "delivered", summary: "echo: Summarize the news" });

      const worker = yield* store.getSession(run!.sessionId!);
      expect(worker).toMatchObject({ role: "worker", title: "⏱ Digest", provider: "codex", parentSessionId: bot.mainSessionId });
      const delivered = (yield* mainMessages).at(-1)!;
      expect(delivered.author).toBe("system");
      expect(delivered.text).toContain('Scheduled task "Digest"');
      expect(delivered.text).toContain("echo: Summarize the news");
      expect(notifications()).toMatchObject([{ title: "Atlas: Digest", body: "echo: Summarize the news", sessionId: worker.id }]);

      const after = yield* scheduler.get(schedule.id);
      expect(after).toMatchObject({ runCount: 1, lastStatus: "delivered", failureStreak: 0 });
      expect(after.nextRunAt).toBe(due + 10 * MINUTE);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("keeps silent runs out of the conversation", () =>
    Effect.gen(function* () {
      const { scheduler, bot, notifications, settled, mainMessages } = yield* setup;
      const schedule = yield* scheduler.create(
        { botId: bot.id, kind: "task", name: "Watch", prompt: "Check quietly for alerts", spec: "every 10m" },
        "user",
      );
      yield* scheduler.runNow(schedule.id);
      const [run] = yield* settled(schedule.id);
      expect(run!.status).toBe("silent");
      expect(yield* mainMessages).toEqual([]);
      expect(notifications()).toEqual([]);
      // A manual run leaves the schedule's timing alone.
      expect((yield* scheduler.get(schedule.id)).nextRunAt).toBe(schedule.nextRunAt);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("turns a schedule off after three failures in a row", () =>
    Effect.gen(function* () {
      const { scheduler, bot, notifications, settled, mainNotices } = yield* setup;
      const schedule = yield* scheduler.create(
        { botId: bot.id, kind: "task", name: "Flaky", prompt: "boom", spec: "every 10m" },
        "user",
      );
      for (let i = 0; i < 3; i++) {
        yield* scheduler.runNow(schedule.id);
        yield* settled(schedule.id);
      }
      const after = yield* scheduler.get(schedule.id);
      expect(after).toMatchObject({ enabled: false, nextRunAt: null, failureStreak: 3, lastStatus: "failed" });
      expect((yield* scheduler.runs(schedule.id)).map((r) => r.summary)).toEqual(["it exploded", "it exploded", "it exploded"]);
      expect((yield* mainNotices).at(-1)).toBe('Scheduled task "Flaky" failed 3 times in a row and was turned off.');
      expect(notifications().at(-1)!.title).toBe('Atlas: "Flaky" turned off');

      // Turning it back on clears the streak.
      const resumed = yield* scheduler.update({ scheduleId: schedule.id, enabled: true });
      expect(resumed).toMatchObject({ enabled: true, failureStreak: 0 });
      expect(resumed.nextRunAt).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("sends heartbeats into the orchestrator's conversation, guarded against scheduling more", () =>
    Effect.gen(function* () {
      const { scheduler, bot, notifications, settled, mainMessages } = yield* setup;
      const schedule = yield* scheduler.create(
        { botId: bot.id, kind: "heartbeat", name: "Check-in", prompt: "slow: anything new?", spec: "every 30m" },
        "bot",
      );
      yield* scheduler.tick(schedule.nextRunAt! + 1000);
      yield* Effect.sleep("50 millis");
      // While the heartbeat's turn runs, the orchestrator may not touch schedules.
      expect(yield* scheduler.isScheduledTurn(bot.mainSessionId)).toBe(true);
      const [run] = yield* settled(schedule.id);
      expect(yield* scheduler.isScheduledTurn(bot.mainSessionId)).toBe(false);
      expect(run).toMatchObject({ status: "delivered", sessionId: bot.mainSessionId });
      expect((yield* mainMessages)[0]!.text).toMatch(/^\[Apollo heartbeat "Check-in"\] slow: anything new\?/);
      expect(notifications()).toMatchObject([{ title: "Atlas: Check-in", sessionId: bot.mainSessionId }]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("waits for a busy orchestrator, then skips a heartbeat that missed its window", () =>
    Effect.gen(function* () {
      const { manager, scheduler, bot, settled } = yield* setup;
      const schedule = yield* scheduler.create(
        { botId: bot.id, kind: "heartbeat", name: "Pulse", prompt: "anything?", spec: "every 30m" },
        "user",
      );
      const due = schedule.nextRunAt!;
      yield* manager.send(bot.mainSessionId, "slow work", "user");
      yield* scheduler.tick(due + MINUTE);
      expect((yield* scheduler.runs(schedule.id)).length).toBe(0);
      expect((yield* scheduler.get(schedule.id)).nextRunAt).toBe(due); // still waiting

      // Past half the period, the run is skipped instead of starting late.
      yield* scheduler.tick(due + 16 * MINUTE);
      const [skipped] = yield* settled(schedule.id);
      expect(skipped).toMatchObject({ status: "skipped", summary: "Skipped: the orchestrator was busy." });
      expect((yield* scheduler.get(schedule.id)).nextRunAt).toBe(due + 30 * MINUTE);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("skips runs missed while Apollo was off, without a backlog, and refuses paused bots", () =>
    Effect.gen(function* () {
      const { manager, scheduler, bot } = yield* setup;
      const schedule = yield* scheduler.create(
        { botId: bot.id, kind: "task", name: "Sync", prompt: "sync", spec: "every 10m" },
        "user",
      );
      const due = schedule.nextRunAt!;
      yield* scheduler.tick(due + 5 * 60 * MINUTE);
      const runs = yield* scheduler.runs(schedule.id);
      expect(runs.length).toBe(1);
      expect(runs[0]!.status).toBe("skipped");
      expect(runs[0]!.summary).toMatch(/^Skipped: Apollo was not running/);
      expect((yield* scheduler.get(schedule.id)).nextRunAt).toBe(due + 31 * 10 * MINUTE);

      yield* manager.stopBot(bot.id);
      const error = yield* Effect.flip(scheduler.runNow(schedule.id));
      expect(error.message).toBe('cannot run "Sync" now: Atlas is paused (you stopped it)');
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("runs a one-shot once, then turns it off", () =>
    Effect.gen(function* () {
      const { scheduler, bot, settled } = yield* setup;
      const schedule = yield* scheduler.create(
        { botId: bot.id, kind: "task", name: "Reminder", prompt: "remind me", spec: "in 2h" },
        "user",
      );
      expect(schedule.description).toMatch(/^Once, /);
      yield* scheduler.tick(schedule.nextRunAt! + 1000);
      const [run] = yield* settled(schedule.id);
      expect(run!.status).toBe("delivered");
      expect(yield* scheduler.get(schedule.id)).toMatchObject({ enabled: false, nextRunAt: null });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("validates schedules", () =>
    Effect.gen(function* () {
      const { scheduler, bot } = yield* setup;
      const create = (spec: string, prompt = "do it") =>
        Effect.flip(scheduler.create({ botId: bot.id, kind: "task", name: "X", prompt, spec }, "bot")).pipe(
          Effect.map((e) => e.message),
        );
      expect(yield* create("every 2m")).toBe("schedules may not run more often than every 5 minutes");
      expect(yield* create("* * * * *")).toBe("schedules may not run more often than every 5 minutes");
      expect(yield* create("2020-01-01 09:00")).toMatch(/has already passed$/);
      expect(yield* create("every 10m", " ")).toBe("say what the schedule should do (its prompt)");
      const preview = yield* scheduler.preview("weekdays at 9am", "UTC");
      expect(preview).toMatchObject({ description: "Weekdays at 9:00 AM", timezone: "UTC" });
      expect(preview.nextRuns.length).toBe(5);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
