import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import * as AppSettings from "./AppSettings.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppChange, AVATAR_SHAPES, type AgentEvent, type BotId, type BotLimits, DEFAULT_BOT_LIMITS, type ProviderKind, type SessionId } from "@apollo/contracts";
import { type Provider, ProviderError, type ProviderSessionOptions } from "@apollo/providers";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { saveAttachment } from "./attachments.ts";
import * as Compaction from "./Compaction.ts";
import { ServerConfig } from "./Config.ts";
import * as Database from "./Database.ts";
import { desktopStatus } from "./DesktopStatus.ts";
import * as Jobs from "./jobs/Jobs.ts";
import * as Push from "./push/Push.ts";
import * as SessionManager from "./SessionManager.ts";
import * as Store from "./Store.ts";

const dataDir = mkdtempSync(join(tmpdir(), "apollo-test-"));
/** Options of every opened provider session, and how often skills were reloaded. */
const opened: Array<ProviderSessionOptions> = [];
/** Every message sent to a fake provider session, in order. */
const sent: Array<string> = [];
/** Instructions passed to each compaction. */
const compactions: Array<string> = [];
/** Attachments sent with each message, in order. */
const sentFiles: Array<ReadonlyArray<{ path: string; name: string }>> = [];
/** Every first message a provider was asked to name a session from. */
const titleRequests: Array<string> = [];
let skillReloads = 0;
let modelListings = 0;
let interrupts = 0;
/** Answers given to the fake agent's questions. */
const inputAnswers: Array<{ requestId: string; action: string }> = [];

/** Each turn of the fake provider uses this much (as a running total per conversation). */
const TURN_USAGE = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, costUsd: 0.01 };

/**
 * A provider that answers every message with `echo: <text>` in one turn and
 * reports TURN_USAGE per turn. Messages containing "slow" take a while, unless
 * interrupted.
 */
const echoProvider = (kind: ProviderKind): Provider => ({
  kind,
  ...(kind === "codex"
    ? {
        listConnectors: Effect.succeed([
          { name: "Slack", kind: "connector" as const, status: "connected" as const, tools: null },
          { name: "Notion", kind: "connector" as const, status: "needs-auth" as const, tools: null },
          { name: "node_repl", kind: "mcp" as const, status: "connected" as const, tools: 4 },
        ]),
      }
    : {}),
  // Claude names untitled sessions; "unnamed" makes it fail, "slow name" makes it take a while.
  ...(kind === "claude"
    ? {
        generateTitle: (text: string) =>
          Effect.suspend(() => {
            titleRequests.push(text);
            if (text.includes("unnamed")) return Effect.fail(new ProviderError({ provider: "claude", message: "no title" }));
            return Effect.sleep(text.includes("slow name") ? "300 millis" : "10 millis").pipe(
              Effect.as(`Named: ${text.split(/\s/)[0]}`),
            );
          }),
      }
    : {}),
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
        send: (text: string, attachments = []) =>
          Effect.gen(function* () {
            const itemId = `msg-${++n}`;
            sent.push(text);
            sentFiles.push(attachments);
            interrupted = false;
            yield* agent({ _tag: "TurnStarted" });
            // "write <file>" edits a file in the session's folder, like an agent would.
            const write = /^write (\S+)$/.exec(text);
            if (write) {
              yield* Effect.sleep("300 millis"); // the turn's snapshot is taken first
              writeFileSync(join(options.cwd, write[1]!), "export const answer = 42;\n");
            }
            // "please ask" makes the agent ask the user a question.
            if (text.includes("please ask")) {
              yield* agent({
                _tag: "InputRequested",
                requestId: `q-${n}`,
                source: "Claude Code",
                message: "Which scope?",
                url: null,
                fields: [],
              });
            }
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
            yield* emit({ _tag: "ContextUsage", used: 1000 * n, window: 200_000 });
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
        respondInput: (requestId: string, response: { action: string }) =>
          Effect.sync(() => void inputAnswers.push({ requestId, action: response.action })),
        compact: (instructions: string) => Effect.sync(() => void compactions.push(instructions)),
        commands: Effect.succeed([{ name: "review", description: "Review the diff", argumentHint: "[focus]" }]),
        reloadSkills: Effect.sync(() => void skillReloads++),
      };
    }),
});

const layerWith = (
  budgetBytes: number,
  database: Layer.Layer<Database.Database, never, ServerConfig> = Database.layerMemory,
  dir = dataDir,
) => SessionManager.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(SessionManager.Providers, {
      claude: echoProvider("claude"),
      codex: echoProvider("codex"),
      llamacpp: echoProvider("llamacpp"),
      cursor: echoProvider("cursor"),
      grok: echoProvider("grok"),
      opencode: echoProvider("opencode"),
      antigravity: echoProvider("antigravity"),
      muse: echoProvider("muse"),
      pi: echoProvider("pi"),
      copilot: echoProvider("copilot"),
    }),
  ),
  Layer.provideMerge(AppSettings.layer),
  Layer.provideMerge(Store.layer),
  Layer.provideMerge(database),
  Layer.provideMerge(
    Layer.succeed(ServerConfig, {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      webDistDir: null,
      baseUrl: "http://127.0.0.1:0",
      claudeExecutable: undefined,
      browser: { executable: undefined, headless: true },
      llamaCpp: { baseUrl: "http://127.0.0.1:8080", apiKey: null },
      codexExecutable: undefined,
    tailnetAddon: undefined,
      allowedOrigins: [],
      publicUrl: "http://127.0.0.1:0",
      desktopBootstrapToken: undefined,
      storage: { budgetBytes, archiveLimit: 2000, detailRetentionMs: 30 * 86_400_000 },
    }),
  ),
);

const layer = layerWith(1e9);

/** Push notification timings short enough for tests. */
const FAST_HOLD: Push.HoldTiming = { settleMs: 20, graceMs: 100, sweepMs: 10 };

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
  it.live("pushes finished turns to paired phones and forgets unregistered ones", () => {
    const pushed: Array<Push.PushMessage> = [];
    const pushLayer = Push.makeLayerWatcher(FAST_HOLD).pipe(
      Layer.provideMerge(Push.Notices.layer),
      Layer.provideMerge(
        Layer.succeed(Push.PushSender, async (messages) => {
          pushed.push(...messages);
          return messages.map((m) =>
            m.to === "ExponentPushToken[gone]" ? { status: "error" as const, details: { error: "DeviceNotRegistered" } } : { status: "ok" as const },
          );
        }),
      ),
      Layer.provideMerge(Jobs.layer),
      Layer.provideMerge(layer),
    );
    return Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const db = yield* Database.Database;
      const tokens = Push.makePushTokens(db);
      const now = Date.now();
      const client = db.prepare(
        "insert into client_sessions (id, token_hash, label, method, created_at, expires_at, last_seen_at, revoked_at) values (?, ?, 'phone', 'pairing-link', ?, ?, ?, ?)",
      );
      client.run("phone", "hash-1", now, now + 1e9, now, null);
      client.run("old-phone", "hash-2", now, now + 1e9, now, now); // revoked
      tokens.register("ExponentPushToken[live]", "phone", "ios");
      tokens.register("ExponentPushToken[gone]", "phone", "ios");
      tokens.register("ExponentPushToken[revoked]", "old-phone", "ios");

      const bot = yield* createBot(manager);
      yield* manager.send(bot.mainSessionId, "ship it", "user");
      yield* waitIdle(manager, bot.mainSessionId);
      yield* Effect.sleep("200 millis");

      expect(pushed.map((m) => m.to).sort()).toEqual(["ExponentPushToken[gone]", "ExponentPushToken[live]"]);
      expect(pushed[0]).toMatchObject({
        title: "Atlas",
        body: "echo: ship it",
        // The bot's avatar travels with it, for the phone to show as the sender.
        data: { sessionId: bot.mainSessionId, kind: "done", botId: bot.id, avatar: bot.avatar },
        mutableContent: true,
      });
      expect(tokens.active()).toEqual(["ExponentPushToken[live]"]);
      // The desktop app polls the same notifications.
      const notices = (yield* Push.Notices).since(0);
      expect(notices).toEqual([{ id: 1, kind: "done", title: "Atlas", body: "echo: ship it", sessionId: bot.mainSessionId }]);
      expect((yield* Push.Notices).since(1)).toEqual([]);
    }).pipe(Effect.provide(pushLayer));
  });

  describe("turn notifications while work is pending", () => {
    /** The watcher with a fake phone: what it pushed, and what the desktop app would show. */
    const watched = () => {
      const pushed: Array<Push.PushMessage> = [];
      const pushLayer = Push.makeLayerWatcher(FAST_HOLD).pipe(
        Layer.provideMerge(Push.Notices.layer),
        Layer.provideMerge(Layer.succeed(Push.PushSender, async (messages) => (pushed.push(...messages), messages.map(() => ({ status: "ok" as const }))))),
        Layer.provideMerge(Jobs.layer),
        Layer.provideMerge(layer),
      );
      const pair = Effect.gen(function* () {
        const db = yield* Database.Database;
        const now = Date.now();
        db.prepare(
          "insert into client_sessions (id, token_hash, label, method, created_at, expires_at, last_seen_at, revoked_at) values ('phone', 'h', 'phone', 'pairing-link', ?, ?, ?, null)",
        ).run(now, now + 1e9, now);
        Push.makePushTokens(db).register("ExponentPushToken[phone]", "phone", "ios");
      });
      return { pushed, pushLayer, pair };
    };
    const until = (check: () => boolean) =>
      Effect.gen(function* () {
        for (let i = 0; i < 200 && !check(); i++) yield* Effect.sleep("25 millis");
      });

    it.live("holds the orchestrator's turn while its worker runs, and notifies the turn after the report", () => {
      const { pushed, pushLayer, pair } = watched();
      return Effect.gen(function* () {
        yield* pair;
        const manager = yield* SessionManager.SessionManager;
        const bot = yield* createBot(manager);
        // The orchestrator spawns a worker and ends its turn ("I'll report back").
        yield* manager.createSession({
          botId: bot.id,
          title: "task",
          provider: bot.defaultWorker,
          prompt: "slow work",
          parentSessionId: bot.mainSessionId,
          notifyParent: true,
          author: "bot",
        });
        yield* manager.send(bot.mainSessionId, "spawned a worker", "user");
        yield* waitIdle(manager, bot.mainSessionId);
        yield* Effect.sleep("200 millis");
        expect(pushed).toEqual([]);
        // The worker reports; the orchestrator's next turn is the one the user hears about.
        yield* until(() => pushed.length > 0);
        yield* Effect.sleep("200 millis");
        expect(pushed).toHaveLength(1);
        expect(pushed[0]).toMatchObject({ title: "Atlas", data: { sessionId: bot.mainSessionId, kind: "done" } });
        expect(pushed[0]!.body).toContain('Worker session "task"');
        // The desktop app shows the same single notice.
        expect((yield* Push.Notices).since(0)).toHaveLength(1);
      }).pipe(Effect.provide(pushLayer));
    });

    it.live("holds a turn while a background job it started runs", () => {
      const { pushed, pushLayer, pair } = watched();
      return Effect.gen(function* () {
        yield* pair;
        const manager = yield* SessionManager.SessionManager;
        const jobs = yield* Jobs.Jobs;
        const bot = yield* createBot(manager);
        yield* jobs.start({ botId: bot.id, sessionId: bot.mainSessionId }, { command: "sleep 0.6" });
        // A server it will not hear back from does not hold anything.
        yield* jobs.start({ botId: bot.id, sessionId: bot.mainSessionId }, { command: "sleep 30", notify: false });
        yield* manager.send(bot.mainSessionId, "started the build", "user");
        yield* waitIdle(manager, bot.mainSessionId);
        yield* Effect.sleep("200 millis");
        expect(pushed).toEqual([]);
        yield* until(() => pushed.length > 0);
        yield* Effect.sleep("200 millis");
        expect(pushed).toHaveLength(1);
        expect(pushed[0]!.body).toContain("Background job");
      }).pipe(Effect.provide(pushLayer));
    });

    it.live("holds a turn waiting for another bot, whose side conversation stays quiet", () => {
      const { pushed, pushLayer, pair } = watched();
      return Effect.gen(function* () {
        yield* pair;
        const manager = yield* SessionManager.SessionManager;
        const atlas = yield* createBot(manager);
        yield* manager.createBot({
          name: "Vega",
          instructions: "",
          cwd: "/tmp",
          main: { provider: "claude" },
          defaultWorker: { provider: "codex" },
          runtimeMode: "full-access",
          autoLearn: false,
        });
        yield* manager.askBot(atlas.mainSessionId, "Vega", "slow question");
        yield* manager.send(atlas.mainSessionId, "asked Vega", "user");
        yield* waitIdle(manager, atlas.mainSessionId);
        yield* Effect.sleep("200 millis");
        expect(pushed).toEqual([]);
        yield* until(() => pushed.length > 0);
        yield* Effect.sleep("300 millis");
        // One notification: Atlas's turn with Vega's answer, not Vega's side conversation.
        expect(pushed).toHaveLength(1);
        expect(pushed[0]).toMatchObject({ title: "Atlas", data: { sessionId: atlas.mainSessionId } });
        expect(pushed[0]!.body).toContain("Vega, another of the user's bots, answered");
      }).pipe(Effect.provide(pushLayer));
    });
  });

  it.live("tracks context usage and runs slash commands", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);
      yield* manager.send(bot.mainSessionId, "hello", "user");
      yield* waitIdle(manager, bot.mainSessionId);
      expect((yield* store.getSession(bot.mainSessionId)).context).toEqual({ used: 1000, window: 200_000 });

      const commands = yield* manager.listCommands(bot.mainSessionId);
      expect(commands.map((c) => `${c.source}:${c.name}`)).toEqual([
        "apollo:compact",
        "apollo:clear",
        "apollo:stop",
        "apollo:reflect",
        "provider:review",
      ]);

      yield* manager.runCommand(bot.mainSessionId, "compact", "keep the API decisions");
      expect(compactions.at(-1)).toBe("keep the API decisions");

      // Unknown to Apollo: goes to the harness as a message.
      yield* manager.runCommand(bot.mainSessionId, "review", "auth module");
      yield* waitIdle(manager, bot.mainSessionId);
      expect(sent.at(-1)).toBe("/review auth module");

      // A process starting up (e.g. to list commands) is not a turn: /clear still works.
      yield* store.updateSession(bot.mainSessionId, { status: "starting" });
      yield* manager.runCommand(bot.mainSessionId, "clear", "");
      const cleared = yield* store.getSession(bot.mainSessionId);
      expect(cleared.status).toBe("idle");
      expect(cleared).toMatchObject({ resumeId: null, context: null });
      expect((yield* store.listEvents(bot.mainSessionId, 0)).at(-1)?.event).toEqual({ _tag: "ConversationCleared" });
    }).pipe(Effect.provide(layer)),
  );

  it.live("tells the orchestrator which connectors each provider's workers can use", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      expect((yield* manager.listConnectors("codex")).map((c) => c.name)).toEqual(["Slack", "Notion", "node_repl"]);
      expect(yield* manager.listConnectors("claude")).toEqual([]);
      const bot = yield* createBot(manager);
      yield* manager.send(bot.mainSessionId, "hi", "user");
      yield* waitIdle(manager, bot.mainSessionId);
      const instructions = opened.at(-1)!.instructions;
      expect(instructions).toContain("### What each provider can reach");
      expect(instructions).toContain("- Codex workers: connectors: Slack; MCP servers: node_repl (4 tools) (1 more need the user to sign in).");
      expect(instructions).toContain("- Claude workers: no connectors.");
    }).pipe(Effect.provide(layer)),
  );

  it.live("passes attached files to the provider and records them on the message", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);
      const ref = saveAttachment(dataDir, bot.mainSessionId, "../../evil name.png", "image/png", new Uint8Array([1, 2, 3]));
      expect(ref.name).toBe("evil name.png");

      yield* manager.send(bot.mainSessionId, "what is this?", "user", [ref]);
      yield* waitIdle(manager, bot.mainSessionId);
      const files = sentFiles.at(-1)!;
      expect(files.map((f) => f.name)).toEqual(["evil name.png"]);
      expect(readFileSync(files[0]!.path)).toEqual(Buffer.from([1, 2, 3]));
      const message = (yield* store.listEvents(bot.mainSessionId, 0)).find((e) => e.event._tag === "UserMessage")!.event;
      expect(message).toMatchObject({ attachments: [{ id: ref.id, name: "evil name.png", mime: "image/png", size: 3 }] });

      const missing = yield* manager
        .send(bot.mainSessionId, "again", "user", [{ ...ref, id: "att_000000000000" }])
        .pipe(Effect.flip);
      expect(missing.message).toContain("attachment is missing");
    }).pipe(Effect.provide(layer)),
  );

  it.live("names sessions started without a title from their first message", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);
      const title = (id: SessionId) => store.getSession(id).pipe(Effect.map((s) => s.title));

      // With a first message: its opening words at once, then the model's title.
      const prompted = yield* manager.createSession({
        botId: bot.id,
        title: "  ",
        provider: { provider: "claude" },
        prompt: "Refactor\nthe billing   service so invoices are retried when the payment provider times out",
      });
      expect(prompted.title).toBe("Refactor the billing service so invoices are…");
      yield* Effect.sleep("100 millis");
      expect(yield* title(prompted.id)).toBe("Named: Refactor");

      // Without one: named from the first message the user sends, and only that one.
      const empty = yield* manager.createSession({ botId: bot.id, title: "", provider: { provider: "claude" } });
      expect(empty.title).toBe("New session");
      yield* manager.send(empty.id, "Deploy the docs site", "user");
      yield* Effect.sleep("100 millis");
      expect(yield* title(empty.id)).toBe("Named: Deploy");
      yield* manager.send(empty.id, "Something else entirely", "user");
      yield* Effect.sleep("100 millis");
      expect(yield* title(empty.id)).toBe("Named: Deploy");

      // When the model cannot answer, the opening words stay.
      const failed = yield* manager.createSession({ botId: bot.id, title: "", provider: { provider: "claude" }, prompt: "unnamed task" });
      yield* Effect.sleep("100 millis");
      expect(yield* title(failed.id)).toBe("unnamed task");
    }).pipe(Effect.provide(layer)),
  );

  it.live("never sends a session's first message to another provider to name it", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);
      titleRequests.length = 0;
      // Local and Codex sessions have no title generator of their own: Claude is not asked.
      const local = yield* manager.createSession({
        botId: bot.id,
        title: "",
        provider: { provider: "llamacpp" },
        prompt: "LOCAL_ONLY payroll figures for review",
      });
      const codex = yield* manager.createSession({ botId: bot.id, title: "", provider: { provider: "codex" } });
      yield* manager.send(codex.id, "CODEX_ONLY first message", "user");
      yield* Effect.sleep("100 millis");
      expect(titleRequests).toEqual([]);
      expect((yield* store.getSession(local.id)).title).toBe("LOCAL_ONLY payroll figures for review");
      expect((yield* store.getSession(codex.id)).title).toBe("CODEX_ONLY first message");
      // A Claude session is named by Claude.
      yield* manager.createSession({ botId: bot.id, title: "", provider: { provider: "claude" }, prompt: "Claude task" });
      yield* Effect.sleep("100 millis");
      expect(titleRequests).toEqual(["Claude task"]);
    }).pipe(Effect.provide(layer)),
  );

  it.live("never replaces a title the user gave", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);
      const title = (id: SessionId) => store.getSession(id).pipe(Effect.map((s) => s.title));
      titleRequests.length = 0;

      // Given at the start.
      const given = yield* manager.createSession({ botId: bot.id, title: "Mine", provider: { provider: "claude" }, prompt: "Ship it" });
      // Renamed before the first message.
      const early = yield* manager.createSession({ botId: bot.id, title: "", provider: { provider: "claude" } });
      yield* manager.updateSessionSettings({ sessionId: early.id, title: "User chose this" });
      yield* manager.send(early.id, "first message", "user");
      // Renamed while the model thinks, to another title or to the very same words.
      const renamed = yield* manager.createSession({ botId: bot.id, title: "", provider: { provider: "claude" }, prompt: "slow name please" });
      yield* manager.updateSessionSettings({ sessionId: renamed.id, title: "Renamed" });
      const kept = yield* manager.createSession({ botId: bot.id, title: "", provider: { provider: "claude" }, prompt: "slow name keep these words" });
      yield* manager.updateSessionSettings({ sessionId: kept.id, title: "slow name keep these words" });
      yield* Effect.sleep("500 millis");

      expect(yield* title(given.id)).toBe("Mine");
      expect(yield* title(early.id)).toBe("User chose this");
      expect(yield* title(renamed.id)).toBe("Renamed");
      expect(yield* title(kept.id)).toBe("slow name keep these words");
      expect(titleRequests).toEqual(["slow name please", "slow name keep these words"]);
    }).pipe(Effect.provide(layer)),
  );

  it.live("still names a session started empty after the server restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "apollo-restart-"));
    const onDisk = layerWith(1e9, Database.layer, dir);
    return Effect.gen(function* () {
      const id = yield* Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const bot = yield* createBot(manager);
        return (yield* manager.createSession({ botId: bot.id, title: "", provider: { provider: "claude" } })).id;
      }).pipe(Effect.provide(onDisk));
      // A new server on the same database.
      yield* Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const store = yield* Store.Store;
        yield* manager.send(id, "Restarted before writing", "user");
        yield* Effect.sleep("100 millis");
        expect((yield* store.getSession(id)).title).toBe("Named: Restarted");
        // Named once: the waiting list is empty again.
        expect(yield* store.getSetting("sessions.untitled")).toBeNull();
      }).pipe(Effect.provide(onDisk));
    });
  });

  it.live("gives workers their own git worktree, then merges or discards it", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);
      const repo = mkdtempSync(join(tmpdir(), "apollo-repo-"));
      const sh = (cmd: string, cwd = repo) => execSync(cmd, { cwd, encoding: "utf8" });
      sh("git init -q -b main && git config user.email t@example.com && git config user.name Test");
      writeFileSync(join(repo, "README.md"), "hello\n");
      sh("git add -A && git commit -qm init");

      const worker = yield* manager.createSession({
        botId: bot.id,
        title: "Add docs",
        provider: { provider: "codex" },
        cwd: repo,
        isolation: "worktree",
      });
      expect(worker.worktree?.branch).toMatch(/^apollo\/add-docs-[0-9a-f]{4}$/);
      expect(worker.cwd).toBe(worker.worktree!.path);
      expect(statSync(join(worker.cwd, "README.md")).isFile()).toBe(true);

      // The worker writes a file and leaves it uncommitted.
      writeFileSync(join(worker.cwd, "DOCS.md"), "docs\n");
      const status = yield* manager.worktreeStatus(worker.id);
      expect(status.uncommitted).toEqual(["?? DOCS.md"]);

      const merged = yield* manager.finishWorktree(worker.id, "merge");
      expect(merged.message).toContain("Merged");
      expect(readFileSync(join(repo, "DOCS.md"), "utf8")).toBe("docs\n");
      expect(sh("git branch --list 'apollo/*'").trim()).toBe("");
      // git reports the resolved path (/private/var on macOS).
      expect((yield* store.getSession(worker.id))).toMatchObject({ worktree: null, cwd: realpathSync(repo) });

      const other = yield* manager.createSession({
        botId: bot.id,
        title: "Try something",
        provider: { provider: "codex" },
        cwd: repo,
        isolation: "worktree",
      });
      writeFileSync(join(other.cwd, "SCRATCH.md"), "x\n");
      yield* manager.finishWorktree(other.id, "discard");
      expect(sh("git branch --list 'apollo/*'").trim()).toBe("");
      expect(sh("git status --porcelain").trim()).toBe("");

      const refused = yield* manager
        .createSession({ botId: bot.id, title: "x", provider: { provider: "codex" }, cwd: tmpdir(), isolation: "worktree" })
        .pipe(Effect.flip);
      expect(refused.message).toContain("not inside a git repository");
    }).pipe(Effect.provide(layer)),
  );

  it.live("runs background jobs, waits on them, reports the ones nobody waited on, and stops them", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const jobs = yield* Jobs.Jobs;
      const bot = yield* createBot(manager);
      const caller = { botId: bot.id, sessionId: bot.mainSessionId };

      const build = yield* jobs.start(caller, { command: "echo building; sleep 0.2; echo done" });
      expect(build.running).toBe(true);
      const finished = yield* jobs.wait(caller, build.jobId, 10);
      expect(finished).toMatchObject({ running: false, exitCode: 0, timedOut: false });
      expect(finished.output).toBe("building\ndone");

      // Nobody waits on this one: the session hears about it.
      yield* jobs.start(caller, { command: "echo oops; exit 3" });
      let report: string | undefined;
      for (let i = 0; i < 80 && !report; i++) {
        yield* Effect.sleep("25 millis");
        report = (yield* store.listEvents(bot.mainSessionId, 0))
          .flatMap((e) => (e.event._tag === "UserMessage" && e.event.author === "system" ? [e.event.text] : []))
          .find((t) => t.includes("Background job"));
      }
      expect(report).toContain("exit code 3");
      expect(report).toContain("oops");

      const server = yield* jobs.start(caller, { command: "sleep 30", notify: false });
      const stopped = yield* jobs.stop(caller, server.jobId);
      expect(stopped.running).toBe(false);
      expect(stopped.signal).toBe("SIGTERM");
      expect((yield* jobs.list(caller)).length).toBe(3);

      const other = yield* createBot(manager);
      const denied = yield* jobs.status({ botId: other.id, sessionId: other.mainSessionId }, build.jobId).pipe(Effect.flip);
      expect(denied.message).toContain("no background job");
    }).pipe(Effect.provide(Jobs.layer.pipe(Layer.provideMerge(layer)))),
  );

  it.live("runs one reflection at a time, the others in line", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const reflections = () =>
        store.listSessions().pipe(Effect.map((all) => all.filter((s) => s.role === "reflection")));
      const first = yield* createBot(manager);
      const second = yield* createBot(manager);
      // "slow" makes the fake agent take a second over each reflection turn too.
      for (const bot of [first, second]) {
        yield* manager.send(bot.mainSessionId, "something slow to remember", "user");
        yield* waitIdle(manager, bot.mainSessionId);
      }
      const before = sent.filter((t) => t.startsWith("Review this transcript")).length;

      expect(yield* manager.reflect(first.mainSessionId)).not.toBeNull();
      expect(yield* manager.reflect(second.mainSessionId)).toBeNull();
      expect(yield* manager.reflect(second.mainSessionId)).toBeNull(); // already in line
      expect((yield* reflections()).length).toBe(1);
      const queued = (yield* store.listEvents(second.mainSessionId, 0)).filter(
        (e) => e.event._tag === "Notice" && e.event.message.startsWith("Another reflection is running"),
      );
      expect(queued.length).toBe(2);

      // The first finishes and is removed; then the second runs, alone, and is removed too.
      let ran = 0;
      for (let i = 0; i < 200; i++) {
        yield* Effect.sleep("25 millis");
        expect((yield* reflections()).length).toBeLessThanOrEqual(1);
        ran = sent.filter((t) => t.startsWith("Review this transcript")).length - before;
        if (ran === 2 && (yield* reflections()).length === 0) break;
      }
      expect(ran).toBe(2);
      expect((yield* reflections()).length).toBe(0);
    }).pipe(Effect.provide(layer)),
  );

  it.live("tells the bot who an @tag means, without messaging the tagged bot", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const atlas = yield* createBot(manager);
      const vega = yield* manager.createBot({
        name: "Vega",
        instructions: "Owns the billing service.\nMore details.",
        cwd: "/tmp",
        main: { provider: "claude" },
        defaultWorker: { provider: "codex" },
        runtimeMode: "full-access",
        autoLearn: false,
      });

      yield* manager.send(atlas.mainSessionId, "check with @vega about invoices", "user");
      yield* waitIdle(manager, atlas.mainSessionId);
      // The chat shows the message as typed; the agent reads who Vega is.
      const shown = (yield* store.listEvents(atlas.mainSessionId, 0)).map((e) => e.event).find((e) => e._tag === "UserMessage");
      expect(shown).toMatchObject({ text: "check with @vega about invoices", author: "user" });
      const read = sent.findLast((t) => t.startsWith("check with @vega about invoices"));
      expect(read).toContain("- @Vega: another of the user's bots (Owns the billing service.)");
      expect(read).toContain("nothing was sent to them");
      // Nothing reached Vega.
      expect((yield* store.listEvents(vega.mainSessionId, 0)).length).toBe(0);

      // Its own name and email addresses are not tags.
      yield* manager.send(atlas.mainSessionId, "@Atlas, mail ops@vega.dev", "user");
      yield* waitIdle(manager, atlas.mainSessionId);
      expect(sent.findLast((t) => t.startsWith("@Atlas, mail"))).toBe("@Atlas, mail ops@vega.dev");
    }).pipe(Effect.provide(layer)),
  );

  it.live("lets bots write to each other, with answers sent back and a limit without the user", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const atlas = yield* createBot(manager);
      const vega = yield* manager.createBot({
        name: "Vega",
        instructions: "Owns the billing service.",
        cwd: "/tmp",
        main: { provider: "claude" },
        defaultWorker: { provider: "codex" },
        runtimeMode: "full-access",
        autoLearn: false,
      });

      expect(yield* manager.askBot(atlas.mainSessionId, "vega", "Is the invoice job still on cron?")).toEqual({ bot: "Vega" });
      // Vega gets it in a side conversation with Atlas, not in its main thread.
      const channel = (yield* store.listSessions(vega.id)).find((s) => s.title === "Conversation with Atlas");
      expect(channel).toMatchObject({ role: "worker", parentSessionId: null, provider: "claude" });
      expect((yield* store.listEvents(vega.mainSessionId, 0)).length).toBe(0);
      const incoming = (yield* store.listEvents(channel!.id, 0)).map((e) => e.event).find((e) => e._tag === "UserMessage");
      expect(incoming).toMatchObject({ author: "peer", fromBotId: atlas.id, text: "Is the invoice job still on cron?" });
      for (let i = 0; i < 40 && !sent.some((t) => t.startsWith("[Apollo] Atlas, another of the user's bots, writes to you:")); i++) {
        yield* Effect.sleep("25 millis");
      }
      expect(sent.some((t) => t.startsWith("[Apollo] Atlas, another of the user's bots, writes to you:"))).toBe(true);
      // Vega's answer comes back to Atlas.
      let answer: unknown;
      for (let i = 0; i < 80 && !answer; i++) {
        yield* Effect.sleep("25 millis");
        answer = (yield* store.listEvents(atlas.mainSessionId, 0)).map((e) => e.event).find((e) => e._tag === "UserMessage" && e.author === "peer");
      }
      expect(answer).toMatchObject({ fromBotId: vega.id });
      for (let i = 0; i < 40 && !sent.some((t) => t.startsWith("[Apollo] Vega, another of the user's bots, answered your message:")); i++) {
        yield* Effect.sleep("25 millis");
      }
      expect(sent.some((t) => t.startsWith("[Apollo] Vega, another of the user's bots, answered your message:"))).toBe(true);

      // Unknown bots and itself are refused.
      expect((yield* Effect.flip(manager.askBot(atlas.mainSessionId, "Nobody", "hi"))).message).toContain("no bot named");
      expect((yield* Effect.flip(manager.askBot(atlas.mainSessionId, "Atlas", "hi"))).message).toContain("that is you");

      // A few messages, then the user has to take part again.
      for (let i = 0; i < 5; i++) yield* manager.askBot(atlas.mainSessionId, "Vega", `ping ${i}`);
      // Later messages reuse the same side conversation.
      expect((yield* store.listSessions(vega.id)).filter((s) => s.title === "Conversation with Atlas").length).toBe(1);
      expect((yield* Effect.flip(manager.askBot(atlas.mainSessionId, "Vega", "one more"))).message).toContain("check with the user");
      yield* waitIdle(manager, atlas.mainSessionId);
      yield* manager.send(atlas.mainSessionId, "carry on", "user");
      expect(yield* manager.askBot(atlas.mainSessionId, "Vega", "again")).toEqual({ bot: "Vega" });
    }).pipe(Effect.provide(layer)),
  );

  it.live("never lets a reflection ask the user anything", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);
      yield* manager.send(bot.mainSessionId, "notes for later", "user");
      yield* waitIdle(manager, bot.mainSessionId);
      // A transcript with a question in it: the reflection's prompt contains "please ask".
      yield* manager.send(bot.mainSessionId, "please ask me which scope", "user");
      yield* Effect.sleep("50 millis");
      const before = inputAnswers.length;

      const reflection = yield* manager.reflect(bot.mainSessionId).pipe(Effect.orElseSucceed(() => null));
      expect(reflection).not.toBeNull();
      expect(opened.at(-1)?.readOnly).toBe(true);
      for (let i = 0; i < 80 && !inputAnswers.slice(before).some((a) => a.requestId.startsWith("q-")); i++) yield* Effect.sleep("25 millis");
      expect(inputAnswers.slice(before)).toContainEqual(expect.objectContaining({ action: "decline" }));
      // It was never shown as waiting for the user.
      const sessions = yield* store.listSessions();
      expect(sessions.some((s) => s.role === "reflection" && s.status === "waiting-approval")).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.live("keeps excluded messages out of memory search and reflection", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);
      yield* manager.send(bot.mainSessionId, "my favourite colour is zanzibar", "user");
      yield* waitIdle(manager, bot.mainSessionId);
      const events = yield* store.listEvents(bot.mainSessionId, 0);
      const message = events.find((e) => e.event._tag === "UserMessage")!;
      const search = () => store.searchTranscripts(bot.id, "zanzibar", 10, null);
      expect((yield* search()).length).toBe(2); // the message and the echo

      yield* manager.setMemoryExclusion(bot.mainSessionId, message.seq, true);
      expect((yield* search()).map((h) => h.seq)).not.toContain(message.seq);
      expect((yield* store.listEvents(bot.mainSessionId, message.seq)).at(-1)?.event).toEqual({
        _tag: "MemoryExclusion",
        seq: message.seq,
        excluded: true,
      });
      const before = sent.length;
      yield* manager.reflect(bot.mainSessionId);
      // The fake provider records the prompt from its own fiber.
      for (let i = 0; i < 40 && sent.length === before; i++) yield* Effect.sleep("25 millis");
      const prompt = sent.slice(before).find((t) => t.startsWith("Review this transcript"));
      expect(prompt).toBeDefined();
      expect(prompt).not.toContain("USER: my favourite colour");

      yield* manager.setMemoryExclusion(bot.mainSessionId, message.seq, false);
      expect((yield* search()).map((h) => h.seq)).toContain(message.seq);

      const turn = events.find((e) => e.event._tag === "TurnStarted")!;
      const refused = yield* manager.setMemoryExclusion(bot.mainSessionId, turn.seq, true).pipe(Effect.flip);
      expect(refused.message).toContain("only messages");
    }).pipe(Effect.provide(layer)),
  );

  it.live("reports bot activity for the desktop tray", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);
      const idle = (yield* desktopStatus).bots.find((b) => b.id === bot.id);
      expect(idle).toEqual({ id: bot.id, name: "Atlas", paused: false, working: 0, needsYou: 0 });
      expect((yield* desktopStatus).localModels).toBeNull();

      yield* store.updateSession(bot.mainSessionId, { status: "waiting-approval" });
      const waiting = (yield* desktopStatus).bots.find((b) => b.id === bot.id);
      expect(waiting).toMatchObject({ working: 0, needsYou: 1 });
      yield* store.updateSession(bot.mainSessionId, { status: "running" });
      expect((yield* desktopStatus).bots.find((b) => b.id === bot.id)).toMatchObject({ working: 1, needsYou: 0 });
      yield* store.updateSession(bot.mainSessionId, { status: "idle" });
    }).pipe(Effect.provide(layer)),
  );

  it.live("creates the bot's workspace folder and passes project folders to providers", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const settings = yield* AppSettings.AppSettings;
      const projects = mkdtempSync(join(tmpdir(), "apollo-projects-"));
      yield* settings.update({ projectFolders: [projects] });
      const cwd = join(mkdtempSync(join(tmpdir(), "apollo-ws-")), "nested", "atlas");
      const bot = yield* manager.createBot({
        name: "Atlas",
        instructions: "",
        cwd: `${cwd}/`,
        main: { provider: "claude" },
        defaultWorker: { provider: "codex" },
        runtimeMode: "full-access",
        autoLearn: false,
      });
      expect(bot.cwd).toBe(cwd);
      expect(AVATAR_SHAPES).toContain(bot.avatar.shape);
      const updated = yield* manager.updateBot({ botId: bot.id, avatar: { shape: "ghost", color: "lime" } });
      expect(updated.avatar).toEqual({ shape: "ghost", color: "lime" });
      const store = yield* Store.Store;
      expect((yield* store.getBot(bot.id)).avatar).toEqual({ shape: "ghost", color: "lime" });
      expect(statSync(cwd).isDirectory()).toBe(true);
      yield* manager.send(bot.mainSessionId, "hi", "user");
      yield* waitIdle(manager, bot.mainSessionId);
      const options = opened.at(-1)!;
      expect(options.extraDirectories).toEqual([projects]);
      expect(options.instructions).toContain(projects);
      expect(options.instructions).toContain("apollo_list_projects");
      yield* settings.update({ projectFolders: [] });

      const relative = yield* manager.createBot({ ...bot, name: "Nova", cwd: "nova", limits: undefined }).pipe(Effect.flip);
      expect(relative.message).toContain("full path");
    }).pipe(Effect.provide(layer)),
  );

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

  it.live("shows what a worker's turn changed in git and reports it to the orchestrator", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager);
      const repo = realpathSync(mkdtempSync(join(tmpdir(), "apollo-changes-")));
      execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repo });

      const worker = yield* manager.createSession({
        botId: bot.id,
        title: "feature",
        provider: bot.defaultWorker,
        cwd: repo,
        prompt: "write answer.ts",
        parentSessionId: bot.mainSessionId,
        notifyParent: true,
        author: "bot",
      });
      yield* waitIdle(manager, worker.id);

      // Apollo detected the change and put it in the worker's conversation.
      const events = yield* store.listEvents(worker.id, 0);
      expect(events.find((e) => e.event._tag === "FilesChanged")?.event).toMatchObject({
        repos: [{ repo, files: [{ path: "answer.ts", status: "added", additions: 1, deletions: 0 }] }],
      });
      // The orchestrator's view includes its worker's changes.
      const overview = yield* manager.changesList(bot.mainSessionId);
      expect(overview.sessions).toMatchObject([{ sessionId: worker.id, title: "feature", repos: [{ files: [{ path: "answer.ts" }] }] }]);
      const diff = yield* manager.changesFile(worker.id, repo, "answer.ts");
      expect(diff.symbols.map((s) => [s.name, s.change])).toEqual([["answer", "added"]]);

      // The user clears the worker's turn from the Changes panel, by its TurnStarted seq (kept
      // server-side, for every client): its section leaves the overview, listed to be brought
      // back; undo restores it. The conversation's card stays (no FilesChanged seq is listed).
      const filesChanged = events.find((e) => e.event._tag === "FilesChanged")!;
      const turnStarted = events.findLast((e) => e.event._tag === "TurnStarted" && e.seq < filesChanged.seq)!;
      expect(overview.sessions[0]?.turns).toEqual([turnStarted.seq]);
      expect(overview.cleared).toEqual([]);
      yield* manager.dismissChanges(worker.id, turnStarted.seq, true);
      expect(yield* manager.changesList(bot.mainSessionId)).toEqual({
        sessions: [],
        cleared: [{ sessionId: worker.id, title: "feature", seqs: [turnStarted.seq] }],
      });
      expect((yield* Effect.flip(manager.changesFile(worker.id, repo, "answer.ts"))).message).toContain("not among");
      expect((yield* manager.changesList(worker.id)).sessions).toEqual([]);
      expect((yield* manager.changesConversation(worker.id)).dismissed).not.toContain(filesChanged.seq);
      yield* manager.dismissChanges(worker.id, turnStarted.seq, false);
      expect(yield* manager.changesList(bot.mainSessionId)).toMatchObject({
        sessions: [{ sessionId: worker.id, repos: [{ files: [{ path: "answer.ts" }] }], turns: [turnStarted.seq] }],
        cleared: [],
      });
      // An older client clears the card (FilesChanged seq): the turn leaves the panel too, and
      // is offered back by that seq.
      yield* manager.dismissChanges(worker.id, filesChanged.seq, true);
      expect((yield* manager.changesList(bot.mainSessionId)).cleared).toEqual([{ sessionId: worker.id, title: "feature", seqs: [filesChanged.seq] }]);
      expect((yield* manager.changesConversation(worker.id)).dismissed).toEqual([filesChanged.seq]);
      yield* manager.dismissChanges(worker.id, filesChanged.seq, false);
      expect((yield* manager.changesConversation(worker.id)).dismissed).toEqual([]);
      const message = events.find((e) => e.event._tag === "UserMessage")!;
      const refused = yield* manager.dismissChanges(worker.id, message.seq, true).pipe(Effect.flip);
      expect(refused.message).toContain("only a turn's changes");

      // And the report to the orchestrator lists the file.
      yield* Effect.sleep(Duration.millis(50));
      yield* waitIdle(manager, bot.mainSessionId);
      const report = (yield* store.listEvents(bot.mainSessionId, 0)).find((e) => e.event._tag === "UserMessage");
      expect(report?.event._tag === "UserMessage" && report.event.text).toContain("- answer.ts (added, +1 -0)");
    }).pipe(Effect.provide(layer)),
  );

  it.live("shows the full semantic diff of a repository only in a turn the user started by asking", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const db = yield* Database.Database;
      const bot = yield* createBot(manager);
      const repo = realpathSync(mkdtempSync(join(tmpdir(), "apollo-report-")));
      execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repo });
      const worker = yield* manager.createSession({
        botId: bot.id,
        title: "feature",
        provider: bot.defaultWorker,
        cwd: repo,
        prompt: "write answer.ts",
        parentSessionId: bot.mainSessionId,
        author: "bot",
      });
      yield* waitIdle(manager, worker.id);
      /** Sends a slow message (the fake agent takes a second) and waits for its turn to start. */
      const during = (text: string, author: "user" | "system" | "bot") =>
        Effect.gen(function* () {
          yield* manager.send(worker.id, `slow: ${text}`, author);
          for (let i = 0; i < 100 && !(yield* store.currentTurn(worker.id)).running; i++) yield* Effect.sleep(Duration.millis(10));
        });
      const ask = (request: string) => manager.semanticDiff(worker.id, { request });

      // Outside any turn, nothing authorizes it.
      expect((yield* Effect.flip(ask("write answer.ts"))).message).toContain("no turn the user started");

      // The user asks: in that turn, the report goes into the conversation as a card.
      yield* during("Give me the full semantic diff please", "user");
      expect((yield* Effect.flip(ask("review everything"))).message).toContain("not in the user's message for this turn");
      const shown = yield* ask("full semantic diff");
      yield* waitIdle(manager, worker.id);
      expect(shown.repo.files.map((f) => f.path)).toEqual(["answer.ts"]);
      expect(shown.report).toMatchObject({ commitCount: 0, uncommitted: true, additions: 1, deletions: 0 });
      const event = yield* store.eventAt(worker.id, shown.seq);
      expect(event).toMatchObject({ _tag: "FilesChanged", repos: [{ repo }], report: { uncommitted: true } });
      // A full diff is no turn of the Changes panel: the panel never offers to clear it, and
      // an older client clearing its card leaves the panel as it was.
      const panel = yield* manager.changesList(worker.id);
      expect(panel.sessions[0]?.turns).not.toContain(shown.seq);
      yield* manager.dismissChanges(worker.id, shown.seq, true);
      expect(yield* manager.changesList(worker.id)).toEqual(panel);
      yield* manager.dismissChanges(worker.id, shown.seq, false);

      // A day later, automated turns cannot reuse that request: not a system turn, not a bot's.
      db.prepare("update session_events set at = at - 86400000 where session_id = ?").run(worker.id);
      for (const author of ["system", "bot"] as const) {
        yield* during(`maintenance (${author})`, author);
        expect((yield* Effect.flip(ask("full semantic diff"))).message).toContain(`a ${author} message`);
        yield* waitIdle(manager, worker.id);
      }
      // Nor a turn the user started that a worker's report then joined.
      yield* during("full semantic diff again", "user");
      yield* manager.send(worker.id, "worker report", "system");
      expect((yield* Effect.flip(ask("full semantic diff"))).message).toContain("a system message");
      yield* waitIdle(manager, worker.id);

      // Its files open as semantic diffs from the snapshot, whatever changed since.
      writeFileSync(join(repo, "answer.ts"), "export const answer = 43;\n");
      const diff = yield* manager.changesFile(worker.id, repo, "answer.ts", shown.seq);
      expect(diff.symbols.map((s) => [s.name, s.change])).toEqual([["answer", "added"]]);
      expect(diff.symbols[0]?.hunks[0]?.lines.map((l) => l.text)).toEqual(["export const answer = 42;"]);
      const missing = yield* Effect.flip(manager.changesFile(worker.id, repo, "answer.ts", shown.seq - 1));
      expect(missing.message).toContain("no full diff");
    }).pipe(Effect.provide(layer)),
    // Four slow (one-second) turns of the fake agent.
    30_000,
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

      const prompt = sent.findLast((t) => t.startsWith("Review this transcript"));
      expect(prompt).toContain("USER: three");
      // A finished reflection removes itself.
      const sessions = yield* store.listSessions(bot.id);
      expect(sessions.some((s) => s.role === "reflection")).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.live("deletes a bot with everything it owns, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "apollo-delete-bot-"));
    return Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const db = yield* Database.Database;
      const jobs = yield* Jobs.Jobs;
      const seen: Array<AppChange> = [];
      yield* Stream.runForEach(manager.changes, (change) => Effect.sync(() => void seen.push(change))).pipe(Effect.forkChild);
      yield* Effect.sleep("20 millis");

      const bot = yield* createBot(manager);
      const other = yield* createBot(manager);
      const repo = mkdtempSync(join(tmpdir(), "apollo-repo-"));
      execSync("git init -q -b main && git config user.email t@example.com && git config user.name Test", { cwd: repo });
      writeFileSync(join(repo, "README.md"), "hello\n");
      execSync("git add -A && git commit -qm init", { cwd: repo });

      // A worker in its own worktree with a conversation and an attachment, and an untitled one.
      const worker = yield* manager.createSession({ botId: bot.id, title: "Feature", provider: { provider: "codex" }, cwd: repo, isolation: "worktree" });
      yield* manager.send(worker.id, "hello", "user");
      yield* waitIdle(manager, worker.id);
      saveAttachment(dir, worker.id, "shot.png", "image/png", new Uint8Array([1, 2, 3]));
      const untitled = yield* manager.createSession({ botId: bot.id, title: "", provider: { provider: "claude" } });
      expect(yield* store.getSetting("sessions.untitled")).toContain(untitled.id);
      const keptSession = yield* manager.createSession({ botId: other.id, title: "", provider: { provider: "claude" } });

      // Memories, notes, a skill and a schedule of its own; and shared ones.
      const memory = { kind: "fact" as const, tags: [], sourceSessionId: null };
      yield* store.insertMemory({ ...memory, botId: bot.id, content: "The doomed bot's fact." });
      yield* store.insertMemory({ ...memory, botId: null, content: "A fact every bot shares." });
      yield* store.insertMemory({ ...memory, botId: other.id, content: "The other bot's fact." });
      yield* store.setCoreMemory(bot.id, "notes", ["doomed notes"]);
      yield* store.setCoreMemory(bot.id, "user", ["Luc prefers English"]);
      yield* store.setCoreMemory(other.id, "notes", ["other notes"]);
      yield* store.insertSkill({ botId: bot.id, name: "deploy", description: "d", body: "b", status: "active", sourceSessionId: null });
      const now = Date.now();
      const schedule = db.prepare(
        `insert into schedules (id, bot_id, kind, name, prompt, spec, timezone, created_by, next_run_at, created_at, updated_at)
         values (?, ?, 'heartbeat', 'tick', 'tick', 'every 1h', 'UTC', 'user', ?, ?, ?)`,
      );
      schedule.run("sch_doomed", bot.id, now + 3_600_000, now, now);
      schedule.run("sch_kept", other.id, now + 3_600_000, now, now);

      // A long-running job of the bot's worker: killed, and never reported.
      const pidFile = join(dir, "job.pid");
      const job = yield* jobs.start({ botId: bot.id, sessionId: worker.id }, { command: `echo $$ > ${pidFile}; exec sleep 30` });
      for (let i = 0; i < 80 && !existsSync(pidFile); i++) yield* Effect.sleep("25 millis");
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      const alive = (p: number) => {
        try {
          process.kill(p, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive(pid)).toBe(true);

      const owned = (yield* store.listSessions(bot.id)).map((s) => s.id);
      expect(owned).toHaveLength(3);
      seen.length = 0;
      yield* manager.deleteBot(bot.id);
      yield* Effect.sleep("50 millis");

      // Everything of the bot is gone.
      expect((yield* store.listBots).map((b) => b.id)).toEqual([other.id]);
      expect(yield* store.listSessions(bot.id)).toEqual([]);
      const count = (sql: string, ...args: Array<string>) => (db.prepare(sql).get(...args) as { n: number }).n;
      for (const id of owned) expect(count("select count(*) as n from session_events where session_id = ?", id)).toBe(0);
      expect(count("select count(*) as n from memories where bot_id = ?", bot.id)).toBe(0);
      expect(count("select count(*) as n from core_memory where scope = ?", bot.id)).toBe(0);
      expect(count("select count(*) as n from skills where bot_id = ?", bot.id)).toBe(0);
      expect(count("select count(*) as n from schedules where bot_id = ?", bot.id)).toBe(0);
      expect(existsSync(join(dir, "attachments", worker.id))).toBe(false);
      expect(existsSync(worker.worktree!.path)).toBe(false);
      expect(yield* store.getSetting("sessions.untitled")).not.toContain(untitled.id);
      expect(alive(pid)).toBe(false);
      expect((yield* jobs.status({ botId: bot.id, sessionId: worker.id }, job.jobId).pipe(Effect.flip)).message).toContain("no background job");

      // Each session's deletion, then the bot's, last.
      const tags = seen.filter((c) => c._tag === "SessionDeleted" || c._tag === "BotDeleted");
      expect(tags.slice(0, -1).map((c) => (c as { sessionId: SessionId }).sessionId).sort()).toEqual([...owned].sort());
      expect(tags.at(-1)).toEqual({ _tag: "BotDeleted", botId: bot.id });
      // The orchestrator goes after its workers.
      expect((tags.at(-2) as { sessionId: SessionId }).sessionId).toBe(bot.mainSessionId);

      // The shared profile, global memories and the other bot are untouched.
      expect(yield* store.getCoreMemory(other.id)).toEqual({ user: ["Luc prefers English"], notes: ["other notes"] });
      expect((yield* store.listMemories(other.id)).map((m) => m.content).sort()).toEqual(["A fact every bot shares.", "The other bot's fact."]);
      expect((yield* store.getSession(keptSession.id)).botId).toBe(other.id);
      expect(yield* store.getSetting("sessions.untitled")).toContain(keptSession.id);
      expect(count("select count(*) as n from schedules where bot_id = ?", other.id)).toBe(1);
      // The workspace folder stays.
      expect(existsSync(bot.cwd)).toBe(true);
      // The global profile can never be deleted with a bot.
      expect((yield* Effect.flip(store.deleteCoreMemoryScope("global" as BotId))).code).toBe("invalid");

      // An unknown (or already deleted) bot is a clean not_found.
      const again = yield* Effect.flip(manager.deleteBot(bot.id));
      expect(again.code).toBe("not_found");
    }).pipe(Effect.provide(Jobs.layer.pipe(Layer.provideMerge(layerWith(1e9, Database.layerMemory, dir)))));
  });

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
