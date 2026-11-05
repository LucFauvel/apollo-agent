import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type BotLimits, DEFAULT_BOT_LIMITS, type ProviderKind, type SessionId } from "@apollo/contracts";
import type { Provider, ProviderSessionOptions } from "@apollo/providers";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Compaction from "./Compaction.ts";
import { ServerConfig } from "./Config.ts";
import * as Database from "./Database.ts";
import * as SessionManager from "./SessionManager.ts";
import * as Store from "./Store.ts";

const dataDir = mkdtempSync(join(tmpdir(), "apollo-test-"));
/** Options of every opened provider session, and how often skills were reloaded. */
const opened: Array<ProviderSessionOptions> = [];
let skillReloads = 0;
let modelListings = 0;
let interrupts = 0;

/** Each turn of the fake provider uses this much (as a running total per conversation). */
const TURN_USAGE = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, costUsd: 0.01 };

/**
 * A provider that answers every message with `echo: <text>` in one turn and
 * reports TURN_USAGE per turn. Messages containing "slow" take a while, unless
 * interrupted.
 */
const echoProvider = (kind: ProviderKind): Provider => ({
  kind,
  listModels: Effect.sync(() => {
    modelListings++;
    return [{ id: `${kind}-big`, label: "Big", description: "", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" }];
  }),
  open: (options, emit) =>
    Effect.gen(function* () {
      opened.push(options);
      const agent = (event: AgentEvent) => emit({ _tag: "Event", event });
      yield* emit({ _tag: "ResumeId", resumeId: `${kind}-thread` });
      const scope = yield* Effect.scope;
      let n = 0;
      let interrupted = false;
      return {
        send: (text: string) =>
          Effect.gen(function* () {
            const itemId = `msg-${++n}`;
            interrupted = false;
            yield* agent({ _tag: "TurnStarted" });
            yield* agent({ _tag: "AssistantDelta", itemId, text: "echo: " });
            if (text.includes("slow")) {
              for (let i = 0; i < 40 && !interrupted; i++) yield* Effect.sleep("25 millis");
            }
            yield* agent({ _tag: "AssistantMessage", itemId, text: `echo: ${text}` });
            yield* emit({
              _tag: "UsageTotals",
              totals: {
                inputTokens: TURN_USAGE.inputTokens * n,
                cachedInputTokens: 0,
                outputTokens: TURN_USAGE.outputTokens * n,
                costUsd: TURN_USAGE.costUsd * n,
              },
            });
            yield* agent({
              _tag: "TurnCompleted",
              outcome: interrupted ? "interrupted" : "completed",
              error: null,
            });
          }).pipe(Effect.forkIn(scope), Effect.asVoid),
        interrupt: Effect.sync(() => {
          interrupts++;
          interrupted = true;
        }),
        respondApproval: () => Effect.void,
        respondInput: () => Effect.void,
        reloadSkills: Effect.sync(() => void skillReloads++),
      };
    }),
});

const layerWith = (budgetBytes: number) => SessionManager.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(SessionManager.Providers, {
      claude: echoProvider("claude"),
      codex: echoProvider("codex"),
      llamacpp: echoProvider("llamacpp"),
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
      storage: { budgetBytes, archiveLimit: 2000, detailRetentionMs: 30 * 86_400_000 },
    }),
  ),
);

const layer = layerWith(1e9);

const createBot = (manager: SessionManager.SessionManager["Service"], autoLearn = false) =>
  manager.createBot({
    name: "Atlas",
    instructions: "",
    cwd: "/tmp",
    main: { provider: "claude" },
    defaultWorker: { provider: "codex" },
    runtimeMode: "full-access",
    autoLearn,
  });

const waitIdle = (manager: SessionManager.SessionManager["Service"], id: SessionId) =>
  manager.waitUntilIdle(id, Duration.seconds(5));

describe("SessionManager", () => {
  it.live("creates a bot with its orchestrator session", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const bot = yield* createBot(manager);
      const { bots, sessions } = yield* manager.snapshot;
      expect(bots.map((b) => b.id)).toEqual([bot.id]);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ id: bot.mainSessionId, role: "main", provider: "claude" });
    }).pipe(Effect.provide(layer)),
  );

  it.live("runs a turn and persists normalized events", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);

      yield* manager.send(bot.mainSessionId, "hello");
      const { session, timedOut } = yield* waitIdle(manager, bot.mainSessionId);

      expect(timedOut).toBe(false);
      expect(session).toMatchObject({
        status: "idle",
        lastMessage: "echo: hello",
        completedTurns: 1,
        resumeId: "claude-thread",
      });
      const events = yield* store.listEvents(bot.mainSessionId, 0);
      // Deltas are live-only and never persisted.
      expect(events.map((e) => e.event._tag)).toEqual([
        "UserMessage",
        "TurnStarted",
        "AssistantMessage",
        "TurnCompleted",
      ]);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    }).pipe(Effect.provide(layer)),
  );

  it.live("replays history then follows live events", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const bot = yield* createBot(manager);
      yield* manager.send(bot.mainSessionId, "first");
      yield* waitIdle(manager, bot.mainSessionId);

      const collected = yield* manager.events(bot.mainSessionId, 2).pipe(
        Stream.filter((e) => e.seq !== 0),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* manager.send(bot.mainSessionId, "second");
      const events = Array.from(yield* Fiber.join(collected));
      expect(events.map((e) => e.seq)).toEqual([3, 4, 5, 6, 7, 8]);
    }).pipe(Effect.provide(layer)),
  );

  it.live("mixes providers and reports worker turns to the orchestrator", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);

      const worker = yield* manager.createSession({
        botId: bot.id,
        title: "task",
        provider: bot.defaultWorker,
        prompt: "do the thing",
        parentSessionId: bot.mainSessionId,
        notifyParent: true,
        author: "bot",
      });
      expect(worker.provider).toBe("codex");

      yield* waitIdle(manager, worker.id);
      // The report is delivered in the background; give it a moment, then wait for the parent's turn.
      yield* Effect.sleep(Duration.millis(50));
      yield* waitIdle(manager, bot.mainSessionId);

      const parentEvents = yield* store.listEvents(bot.mainSessionId, 0);
      const report = parentEvents.find((e) => e.event._tag === "UserMessage");
      expect(report?.event).toMatchObject({ _tag: "UserMessage", author: "system" });
      expect(report?.event._tag === "UserMessage" && report.event.text).toContain("echo: do the thing");
    }).pipe(Effect.provide(layer)),
  );

  it.live("reflects automatically after enough turns when autoLearn is on", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager, true);

      for (const text of ["one", "two", "three"]) {
        yield* manager.send(bot.mainSessionId, text);
        yield* waitIdle(manager, bot.mainSessionId);
      }
      yield* Effect.sleep(Duration.millis(100));

      const sessions = yield* store.listSessions(bot.id);
      const reflection = sessions.find((s) => s.role === "reflection");
      expect(reflection).toMatchObject({ parentSessionId: bot.mainSessionId, provider: "claude" });
      const prompt = (yield* store.listEvents(reflection!.id, 0))[0]?.event;
      expect(prompt?._tag === "UserMessage" && prompt.text).toContain("USER: three");
    }).pipe(Effect.provide(layer)),
  );

  it.live("refuses to delete a bot's orchestrator session", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const bot = yield* createBot(manager);
      const error = yield* Effect.flip(manager.deleteSession(bot.mainSessionId));
      expect(error.code).toBe("invalid");
    }).pipe(Effect.provide(layer)),
  );

  it.live("mirrors active skills to the native plugin dir and reloads live sessions", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);
      yield* manager.send(bot.mainSessionId, "hi");
      yield* waitIdle(manager, bot.mainSessionId);

      const dir = opened.at(-1)!.skillsPluginDir!;
      expect(dir).toBe(join(dataDir, "skills", bot.id));
      expect(readdirSync(join(dir, "skills"))).toEqual([]);

      const skill = yield* store.insertSkill({
        botId: bot.id,
        name: "release-notes",
        description: "Use when: writing release notes",
        body: "1. Read the changelog.",
        status: "proposed",
        sourceSessionId: null,
      });
      yield* manager.publishSkillChanged(bot.id);
      expect(readdirSync(join(dir, "skills"))).toEqual([]);

      const before = skillReloads;
      yield* store.setSkillStatus(skill.id, "active");
      yield* manager.publishSkillChanged(bot.id);
      expect(readFileSync(join(dir, "skills", "release-notes", "SKILL.md"), "utf8")).toBe(
        '---\nname: "release-notes"\ndescription: "Use when: writing release notes"\n---\n\n1. Read the changelog.\n',
      );
      expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).name).toBe(
        "apollo-skills",
      );
      expect(skillReloads).toBe(before + 1);

      // Nothing changed on disk: no reload.
      yield* manager.publishSkillChanged(null);
      expect(skillReloads).toBe(before + 1);

      yield* store.setSkillStatus(skill.id, "archived");
      yield* manager.publishSkillChanged(bot.id);
      expect(readdirSync(join(dir, "skills"))).toEqual([]);
      expect(skillReloads).toBe(before + 2);
    }).pipe(Effect.provide(layer)),
  );

  it.live("compaction over budget deletes idle workers but keeps the orchestrator", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const compaction = yield* Compaction.Compaction;
      const bot = yield* createBot(manager);
      yield* manager.send(bot.mainSessionId, "plan the work");
      yield* waitIdle(manager, bot.mainSessionId);
      const worker = yield* manager.createSession({
        botId: bot.id,
        title: "task",
        provider: { provider: "codex" },
        prompt: "do it",
      });
      yield* waitIdle(manager, worker.id);
      yield* manager.closeSession(worker.id);

      const report = yield* compaction.compact;
      expect(report.lastCompactedAt).not.toBeNull();
      const sessions = yield* store.listSessions(bot.id);
      expect(sessions.map((s) => s.role)).toEqual(["main"]);
      const messages = (yield* store.listEvents(bot.mainSessionId, 0)).filter((e) => e.event._tag === "UserMessage");
      expect(messages).toHaveLength(1);
    }).pipe(Effect.provide(Compaction.layer.pipe(Layer.provideMerge(layerWith(1))))),
  );

  it.live("applies new session settings by reopening and resuming the conversation", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const bot = yield* createBot(manager);
      yield* manager.send(bot.mainSessionId, "first");
      yield* waitIdle(manager, bot.mainSessionId);
      expect(opened.at(-1)).toMatchObject({ model: null, effort: null, runtimeMode: "full-access" });
      expect(yield* manager.isLive(bot.mainSessionId)).toBe(true);

      const updated = yield* manager.updateSessionSettings({
        sessionId: bot.mainSessionId,
        model: "claude-big",
        effort: "high",
        runtimeMode: "approval-required",
      });
      expect(updated).toMatchObject({ model: "claude-big", effort: "high", runtimeMode: "approval-required" });
      expect(yield* manager.isLive(bot.mainSessionId)).toBe(false);

      yield* manager.send(bot.mainSessionId, "second");
      yield* waitIdle(manager, bot.mainSessionId);
      expect(opened.at(-1)).toMatchObject({
        model: "claude-big",
        effort: "high",
        runtimeMode: "approval-required",
        resumeId: "claude-thread",
      });

      // A title change alone keeps the process.
      yield* manager.updateSessionSettings({ sessionId: bot.mainSessionId, title: "Renamed" });
      expect(yield* manager.isLive(bot.mainSessionId)).toBe(true);

      // Clearing the override follows the bot again.
      yield* manager.updateSessionSettings({ sessionId: bot.mainSessionId, runtimeMode: null });
      yield* manager.send(bot.mainSessionId, "third");
      yield* waitIdle(manager, bot.mainSessionId);
      expect(opened.at(-1)?.runtimeMode).toBe("full-access");
    }).pipe(Effect.provide(layer)),
  );

  it.live("caches provider model lists", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const before = modelListings;
      const models = yield* manager.listModels("codex");
      yield* manager.listModels("codex");
      expect(models[0]?.id).toBe("codex-big");
      expect(modelListings).toBe(before + 1);
    }).pipe(Effect.provide(layer)),
  );

  describe("guardrails", () => {
    const botWith = (manager: SessionManager.SessionManager["Service"], limits: Partial<BotLimits>) =>
      manager.createBot({
        name: "Guarded",
        instructions: "",
        cwd: "/tmp",
        main: { provider: "claude" },
        defaultWorker: { provider: "codex" },
        runtimeMode: "full-access",
        autoLearn: false,
        limits: { ...DEFAULT_BOT_LIMITS, ...limits },
      });

    it.live("tracks usage per session and per bot per day", () =>
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const store = yield* Store.Store;
        const bot = yield* botWith(manager, {});
        for (const text of ["one", "two"]) {
          yield* manager.send(bot.mainSessionId, text);
          yield* waitIdle(manager, bot.mainSessionId);
        }
        const session = yield* store.getSession(bot.mainSessionId);
        expect(session.usage).toEqual({ inputTokens: 2000, cachedInputTokens: 0, outputTokens: 200, costUsd: 0.02 });
        const today = (yield* manager.snapshot).usageToday.find((u) => u.botId === bot.id);
        expect(today?.usage.inputTokens).toBe(2000);
      }).pipe(Effect.provide(layer)),
    );

    it.live("pauses automated work over the daily budget, but lets the user through", () =>
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const store = yield* Store.Store;
        const bot = yield* botWith(manager, { dailyTokenBudget: 1500 });
        yield* manager.send(bot.mainSessionId, "first");
        yield* waitIdle(manager, bot.mainSessionId);
        expect((yield* store.getBot(bot.id)).pausedReason).toBeNull();

        yield* manager.send(bot.mainSessionId, "second");
        yield* waitIdle(manager, bot.mainSessionId);
        const paused = yield* store.getBot(bot.id);
        expect(paused.pausedReason).toContain("over its budget of 1,500");
        const notices = (yield* store.listEvents(bot.mainSessionId, 0)).filter((e) => e.event._tag === "Notice");
        expect(notices).toHaveLength(1);

        const refused = yield* Effect.flip(manager.send(bot.mainSessionId, "worker report", "system"));
        expect(refused.message).toContain("paused");
        yield* manager.send(bot.mainSessionId, "the user can still talk");
        yield* waitIdle(manager, bot.mainSessionId);

        expect((yield* Effect.flip(manager.resumeBot(bot.id))).message).toContain("Raise the budget");
        yield* manager.updateBot({ botId: bot.id, limits: { ...paused.limits, dailyTokenBudget: 100_000 } });
        expect((yield* manager.resumeBot(bot.id)).pausedReason).toBeNull();
        yield* manager.send(bot.mainSessionId, "worker report", "system");
      }).pipe(Effect.provide(layer)),
    );

    it.live("pauses after too many orchestrator turns without the user", () =>
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const store = yield* Store.Store;
        const bot = yield* botWith(manager, { maxAutonomousTurns: 2 });
        const automated = (text: string) =>
          manager.send(bot.mainSessionId, text, "system").pipe(Effect.andThen(waitIdle(manager, bot.mainSessionId)));

        yield* automated("report 1");
        yield* automated("report 2");
        expect((yield* Effect.flip(automated("report 3"))).message).toContain("too many turns");
        expect((yield* store.getBot(bot.id)).pausedReason).toContain("2 orchestrator turns in a row");

        yield* manager.resumeBot(bot.id);
        yield* automated("report 4");
        // A user message resets the count.
        yield* manager.send(bot.mainSessionId, "hello");
        yield* waitIdle(manager, bot.mainSessionId);
        yield* automated("report 5");
        yield* automated("report 6");
      }).pipe(Effect.provide(layer)),
    );

    it.live("limits concurrent workers and stops everything on demand", () =>
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const store = yield* Store.Store;
        const bot = yield* botWith(manager, { maxConcurrentWorkers: 1 });
        const worker = yield* manager.createSession({
          botId: bot.id,
          title: "slow worker",
          provider: { provider: "codex" },
          prompt: "slow task",
        });
        expect((yield* Effect.flip(manager.guardWorkerCapacity(bot.id))).message).toContain("limit 1");

        // Let the worker's turn get going before stopping it.
        yield* Effect.sleep("100 millis");
        const before = interrupts;
        const stopped = yield* manager.stopBot(bot.id);
        expect(stopped.pausedReason).toBe("you stopped it");
        expect(interrupts).toBe(before + 1);
        const { session } = yield* waitIdle(manager, worker.id);
        expect(session.status).toBe("idle");
        yield* manager.guardWorkerCapacity(bot.id);
        const events = yield* store.listEvents(worker.id, 0);
        expect(events.at(-1)?.event).toMatchObject({ _tag: "TurnCompleted", outcome: "interrupted" });
      }).pipe(Effect.provide(layer)),
    );
  });
});
