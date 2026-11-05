import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  ApolloError,
  type AppChange,
  type ApprovalDecision,
  type Bot,
  type BotId,
  billableTokens,
  formatUsd,
  type CreateBotInput,
  DEFAULT_BOT_LIMITS,
  EMPTY_USAGE,
  type InputResponse,
  type MessageAuthor,
  type ProviderKind,
  type ProviderSelection,
  type Session,
  type SessionEvent,
  type SessionId,
  type SessionRole,
  type SessionStatus,
  type UpdateBotInput,
  type UpdateSessionInput,
  type Usage,
} from "@apollo/contracts";
import {
  makeClaudeProvider,
  makeCodexProvider,
  makeLlamaCppProvider,
  type Provider,
  type ProviderEmission,
  type Environment,
  type LlamaCppConnection,
  ProviderError,
  type ProviderSession,
} from "@apollo/providers";
import * as Context from "effect/Context";
import { LocalModels } from "./local/LocalModels.ts";
import { ProviderSettings } from "./ProviderSettings.ts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ServerConfig } from "./Config.ts";
import {
  buildInstructions,
  MCP_SERVER_NAME,
  reflectionPrompt,
  transcriptForReflection,
} from "./Instructions.ts";
import { pluginDir, syncSkills } from "./SkillSync.ts";
import { newId, Store } from "./Store.ts";

/** Run a reflection pass after this many completed turns (when the bot has autoLearn). */
const REFLECT_EVERY_TURNS = 3;

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export class Providers extends Context.Service<Providers, Record<ProviderKind, Provider>>()(
  "apollo/Providers",
) {}

export const layerProviders = Layer.effect(
  Providers,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ProviderSettings;
    const localModels = yield* LocalModels;
    return {
      claude: makeClaudeProvider({
        executable: config.claudeExecutable,
        environment: Effect.flatMap(settings.read, ({ claude }): Effect.Effect<Environment, ProviderError> => {
          if (claude.auth === "subscription") {
            // An inherited key would win over the login.
            return Effect.succeed({ ANTHROPIC_API_KEY: undefined });
          }
          return claude.apiKey
            ? Effect.succeed({ ANTHROPIC_API_KEY: claude.apiKey, CLAUDE_CODE_OAUTH_TOKEN: undefined })
            : Effect.fail(
                new ProviderError({
                  provider: "claude",
                  message: "Claude is set to use an API key, but none is saved. Add one in provider settings.",
                }),
              );
        }),
      }),
      codex: makeCodexProvider({ executable: config.codexExecutable }),
      llamacpp: makeLlamaCppProvider({
        executable: config.claudeExecutable,
        connection: Effect.flatMap(
          settings.read,
          ({ llamacpp }): Effect.Effect<LlamaCppConnection, ProviderError> =>
            llamacpp.mode === "managed" ? localModels.connection : Effect.succeed(llamacpp),
        ),
      }),
    };
  }),
);

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

interface LiveSession {
  readonly botId: BotId;
  readonly scope: Scope.Closeable;
  readonly provider: ProviderSession;
  readonly token: string;
}

const invalid = (message: string) => new ApolloError({ code: "invalid", message });
const providerFailure = (message: string) => new ApolloError({ code: "provider", message });

const isBusy = (status: SessionStatus) =>
  status === "starting" || status === "running" || status === "waiting-approval";

const make = Effect.gen(function* () {
  const store = yield* Store;
  const config = yield* ServerConfig;
  const providers = yield* Providers;
  const managerScope = yield* Effect.scope;

  const changes = yield* PubSub.unbounded<AppChange>();
  const events = yield* PubSub.unbounded<SessionEvent>();

  const live = new Map<SessionId, LiveSession>();
  const tokens = new Map<string, SessionId>();
  const locks = new Map<SessionId, Semaphore.Semaphore>();

  const lockFor = (id: SessionId) => {
    let lock = locks.get(id);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(id, lock);
    }
    return lock;
  };

  /** Fire-and-forget work owned by the manager (outlives the triggering request). */
  const background = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.catchCause((cause) => Effect.logWarning("background task failed", cause)),
      Effect.forkIn(managerScope),
      Effect.asVoid,
    );

  const publish = (change: AppChange) => PubSub.publish(changes, change).pipe(Effect.asVoid);

  const updateSession = (id: SessionId, patch: Parameters<typeof store.updateSession>[1]) =>
    store.updateSession(id, patch).pipe(
      Effect.tap((session) => publish({ _tag: "SessionUpserted", session })),
    );

  const appendEvent = (sessionId: SessionId, event: AgentEvent) =>
    store.appendEvent(sessionId, event).pipe(
      Effect.tap((stored) => PubSub.publish(events, stored)),
    );

  // --- live provider sessions --------------------------------------------

  const closeLive = (id: SessionId) =>
    Effect.suspend(() => {
      const entry = live.get(id);
      if (!entry) return Effect.void;
      live.delete(id);
      tokens.delete(entry.token);
      return Scope.close(entry.scope, Exit.void);
    });

  const handleEmission =
    (id: SessionId, generation: object) =>
    (emission: ProviderEmission): Effect.Effect<void> =>
      Effect.gen(function* () {
        switch (emission._tag) {
          case "ResumeId": {
            yield* updateSession(id, { resumeId: emission.resumeId });
            return;
          }
          case "UsageTotals": {
            yield* onUsage(id, emission.totals);
            return;
          }
          case "Exited": {
            // Ignore exits from a session we already replaced or closed on purpose.
            if (generations.get(id) !== generation) return;
            yield* background(
              Effect.gen(function* () {
                yield* closeLive(id);
                const session = yield* store.getSession(id);
                if (isBusy(session.status)) {
                  yield* appendEvent(id, { _tag: "Notice", level: "error", message: emission.reason });
                  yield* appendEvent(id, {
                    _tag: "TurnCompleted",
                    outcome: "failed",
                    error: emission.reason,
                  });
                  yield* updateSession(id, { status: "idle" });
                }
              }),
            );
            return;
          }
          case "Event": {
            const event = emission.event;
            if (event._tag === "AssistantDelta") {
              // Deltas are live-only (seq 0); the final AssistantMessage is persisted.
              yield* PubSub.publish(events, { sessionId: id, seq: 0, at: Date.now(), event });
              return;
            }
            yield* appendEvent(id, event);
            switch (event._tag) {
              case "TurnStarted":
                yield* updateSession(id, { status: "running" });
                return;
              case "ApprovalRequested":
              case "InputRequested":
                yield* updateSession(id, { status: "waiting-approval" });
                return;
              case "ApprovalResolved":
              case "InputResolved":
                yield* updateSession(id, { status: "running" });
                return;
              case "AssistantMessage":
                yield* updateSession(id, { lastMessage: event.text });
                return;
              case "TurnCompleted":
                yield* onTurnCompleted(id, event);
                return;
              default:
                return;
            }
          }
        }
      }).pipe(Effect.catchCause((cause) => Effect.logError("failed to handle provider emission", cause)));

  const generations = new Map<SessionId, object>();

  // --- native skills --------------------------------------------------------

  /** Mirrors the bot's active skills to its plugin dir; true when files changed. */
  const syncBotSkills = (botId: BotId) =>
    Effect.gen(function* () {
      const skills = yield* store.listSkills(botId);
      const dir = pluginDir(config.dataDir, botId);
      return yield* Effect.try({
        try: () => syncSkills(dir, skills),
        catch: (cause) => cause,
      });
    });

  /** Resyncs after a skill changed and asks the bot's live sessions to reload. */
  const resyncSkills = (botId: BotId | null) =>
    Effect.gen(function* () {
      const botIds = botId === null ? (yield* store.listBots).map((b) => b.id) : [botId];
      for (const id of botIds) {
        const changed = yield* syncBotSkills(id).pipe(
          Effect.catch((cause) => Effect.logWarning("skill sync failed", cause).pipe(Effect.as(false))),
        );
        if (!changed) continue;
        for (const [sessionId, entry] of live) {
          if (entry.botId !== id) continue;
          yield* entry.provider.reloadSkills.pipe(
            Effect.catch((error) => Effect.logWarning(`skill reload failed for ${sessionId}`, error)),
          );
        }
      }
    });

  const ensureOpen = (id: SessionId): Effect.Effect<LiveSession, ApolloError> =>
    Semaphore.withPermit(
      lockFor(id),
      Effect.gen(function* () {
        const existing = live.get(id);
        if (existing) return existing;

        const session = yield* store.getSession(id);
        const bot = yield* store.getBot(session.botId);
        const [core, skills] = yield* Effect.all([store.getCoreMemory(bot.id), store.listSkills(bot.id)]);
        const skillsPluginDir = yield* syncBotSkills(bot.id).pipe(
          Effect.as(pluginDir(config.dataDir, bot.id)),
          Effect.catch((cause) => Effect.logWarning("skill sync failed", cause).pipe(Effect.as(null))),
        );
        const token = randomUUID();
        const generation = {};
        generations.set(id, generation);
        const scope = yield* Scope.make();

        yield* updateSession(id, { status: "starting" });
        const opened = yield* providers[session.provider]
          .open(
            {
              cwd: session.cwd,
              model: session.model,
              effort: session.effort,
              resumeId: session.resumeId,
              instructions: buildInstructions({ bot, session, core, skills }),
              runtimeMode: session.runtimeMode ?? bot.runtimeMode,
              mcp: { name: MCP_SERVER_NAME, url: `${config.baseUrl}/mcp`, bearerToken: token },
              skillsPluginDir,
            },
            handleEmission(id, generation),
          )
          .pipe(Scope.provide(scope), Effect.exit);

        if (Exit.isFailure(opened)) {
          yield* Scope.close(scope, Exit.void);
          const message = Option.match(Exit.findErrorOption(opened), {
            onNone: () => "provider failed to start",
            onSome: (error) => error.message,
          });
          yield* appendEvent(id, { _tag: "Notice", level: "error", message });
          yield* updateSession(id, { status: "error" });
          return yield* providerFailure(message);
        }

        const entry: LiveSession = { botId: bot.id, scope, provider: opened.value, token };
        live.set(id, entry);
        tokens.set(token, id);
        yield* updateSession(id, { status: "idle" });
        return entry;
      }),
    );

  // --- guardrails -----------------------------------------------------------

  /** Orchestrator turns in a row that the user did not start, per bot. */
  const autonomousTurns = new Map<BotId, number>();

  const busySessions = (botId: BotId) =>
    store.listSessions(botId).pipe(Effect.map((sessions) => sessions.filter((s) => isBusy(s.status))));

  /** Interrupts every running turn of the bot. */
  const interruptBot = (botId: BotId) =>
    Effect.gen(function* () {
      for (const session of yield* busySessions(botId)) {
        const entry = live.get(session.id);
        if (entry) yield* entry.provider.interrupt.pipe(Effect.ignore);
      }
    });

  /** Pauses the bot's automated work and tells the user why, in the orchestrator's transcript. */
  const pauseBot = (botId: BotId, reason: string) =>
    Effect.gen(function* () {
      const bot = yield* store.setBotPaused(botId, reason);
      yield* publish({ _tag: "BotUpserted", bot });
      yield* appendEvent(bot.mainSessionId, {
        _tag: "Notice",
        level: "warning",
        message: `${bot.name} is paused: ${reason}. Workers will not start or report back until you resume it.`,
      });
      return bot;
    });

  /** Why the bot is over today's budget, or `null` when it is within it. */
  const overBudget = (bot: Bot, today: Usage): string | null => {
    const { dailyTokenBudget, dailyCostBudgetUsd } = bot.limits;
    if (dailyTokenBudget !== null && billableTokens(today) >= dailyTokenBudget) {
      return `it used ${billableTokens(today).toLocaleString("en-US")} tokens today, over its budget of ${dailyTokenBudget.toLocaleString("en-US")}`;
    }
    if (dailyCostBudgetUsd !== null && today.costUsd >= dailyCostBudgetUsd) {
      return `it spent about ${formatUsd(today.costUsd)} today, over its budget of ${formatUsd(dailyCostBudgetUsd)}`;
    }
    return null;
  };

  const onUsage = (id: SessionId, totals: Usage) =>
    Effect.gen(function* () {
      const { session, today } = yield* store.recordUsage(id, totals);
      yield* publish({ _tag: "SessionUpserted", session: yield* store.getSession(id) });
      yield* publish({ _tag: "BotUsageToday", botId: session.botId, usage: today });
      const bot = yield* store.getBot(session.botId);
      const reason = overBudget(bot, today);
      if (reason !== null && bot.pausedReason === null) {
        yield* pauseBot(bot.id, reason);
        yield* interruptBot(bot.id);
      }
    });

  /**
   * Checks a message that does not come from the user: refused while the bot is
   * paused, and counted when it starts an orchestrator turn.
   */
  const guardAutomated = (session: Session) =>
    Effect.gen(function* () {
      const bot = yield* store.getBot(session.botId);
      if (bot.pausedReason !== null) {
        return yield* invalid(`${bot.name} is paused (${bot.pausedReason}). Only the user can resume it.`);
      }
      if (session.role !== "main") return;
      const turns = (autonomousTurns.get(bot.id) ?? 0) + 1;
      autonomousTurns.set(bot.id, turns);
      if (turns > bot.limits.maxAutonomousTurns) {
        yield* pauseBot(bot.id, `it ran ${bot.limits.maxAutonomousTurns} orchestrator turns in a row without you`);
        return yield* invalid(`${bot.name} is paused: too many turns without the user.`);
      }
    });

  /** Refused when the bot already has as many workers running as its limit allows. */
  const guardWorkerCapacity = (botId: BotId) =>
    Effect.gen(function* () {
      const bot = yield* store.getBot(botId);
      const running = (yield* busySessions(botId)).filter((s) => s.role === "worker").length;
      if (running >= bot.limits.maxConcurrentWorkers) {
        return yield* invalid(
          `${running} workers are already running (limit ${bot.limits.maxConcurrentWorkers}). Wait for one with apollo_wait_session before starting more.`,
        );
      }
    });

  // --- turn lifecycle -----------------------------------------------------

  const onTurnCompleted = (id: SessionId, event: Extract<AgentEvent, { _tag: "TurnCompleted" }>) =>
    Effect.gen(function* () {
      const { session, turnsSinceReflection } = yield* store.recordTurn(id);
      yield* updateSession(id, { status: "idle" });
      if (pendingReopen.delete(id)) yield* reopenWithNewSettings(id);

      if (session.role === "reflection") {
        // A reflection is one-shot: free its process once it has answered.
        yield* background(closeSession(id));
        return;
      }

      if (session.parentSessionId !== null && (yield* store.notifiesParent(id))) {
        const report = [
          `[Apollo] Worker session "${session.title}" (${session.id}, ${session.provider}) finished a turn: ${event.outcome}.`,
          event.error ? `Error: ${event.error}` : null,
          session.lastMessage ? `Its last message:\n${session.lastMessage}` : "It produced no final message.",
        ]
          .filter((line) => line !== null)
          .join("\n");
        const parentId = session.parentSessionId;
        yield* background(
          send(parentId, report, "system").pipe(
            // Paused bots hold reports back; say so where the user will look.
            Effect.catchTag("ApolloError", (error) =>
              appendEvent(parentId, {
                _tag: "Notice",
                level: "warning",
                message: `Worker "${session.title}" finished a turn but was not reported: ${error.message}`,
              }),
            ),
          ),
        );
      }

      const bot = yield* store.getBot(session.botId);
      if (
        bot.autoLearn &&
        bot.pausedReason === null &&
        event.outcome === "completed" &&
        turnsSinceReflection >= REFLECT_EVERY_TURNS
      ) {
        yield* background(reflect(id));
      }
    });

  // --- public API ---------------------------------------------------------

  const send = (id: SessionId, text: string, author: MessageAuthor = "user") =>
    Effect.gen(function* () {
      if (text.trim().length === 0) return yield* invalid("message is empty");
      const target = yield* store.getSession(id);
      if (author === "user") {
        // The user is back in the loop.
        if (target.role === "main") autonomousTurns.delete(target.botId);
      } else {
        yield* guardAutomated(target);
      }
      const entry = yield* ensureOpen(id);
      yield* appendEvent(id, { _tag: "UserMessage", text, author });
      // Mark busy before the provider acknowledges the turn, so a caller that
      // immediately waits on this session (e.g. apollo_wait_session) cannot see
      // a stale "idle". TurnCompleted flips it back.
      const before = yield* store.getSession(id);
      if (!isBusy(before.status)) yield* updateSession(id, { status: "running" });
      yield* entry.provider.send(text).pipe(
        Effect.mapError((error) => providerFailure(error.message)),
        Effect.tapError(() => updateSession(id, { status: "idle" }).pipe(Effect.ignore)),
      );
    });

  const createSession = (input: {
    readonly botId: BotId;
    readonly title: string;
    readonly provider: ProviderSelection;
    readonly cwd?: string | undefined;
    readonly role: SessionRole;
    readonly parentSessionId: SessionId | null;
    readonly id?: SessionId;
  }) =>
    Effect.gen(function* () {
      const bot = yield* store.getBot(input.botId);
      const now = Date.now();
      const session = yield* store.insertSession({
        id: input.id ?? newId<SessionId>("ses"),
        botId: bot.id,
        role: input.role,
        parentSessionId: input.parentSessionId,
        title: input.title.trim() || "Untitled session",
        provider: input.provider.provider,
        model: input.provider.model ?? null,
        effort: input.provider.effort ?? null,
        runtimeMode: null,
        cwd: input.cwd?.trim() || bot.cwd,
        status: "idle",
        resumeId: null,
        lastMessage: null,
        completedTurns: 0,
        usage: EMPTY_USAGE,
        createdAt: now,
        updatedAt: now,
      });
      yield* publish({ _tag: "SessionUpserted", session });
      return session;
    });

  // --- settings -------------------------------------------------------------

  /** Sessions whose settings changed mid-turn: reopened once the turn ends. */
  const pendingReopen = new Set<SessionId>();

  /**
   * Applies changed settings (model, effort, runtime mode) to a live session by
   * closing its process; the next message reopens it, resuming the same
   * conversation with the new settings. A running turn is left to finish first.
   */
  const reopenWithNewSettings = (id: SessionId) =>
    Effect.gen(function* () {
      if (!live.has(id)) return;
      const session = yield* store.getSession(id);
      if (isBusy(session.status)) {
        pendingReopen.add(id);
        return;
      }
      generations.delete(id);
      yield* closeLive(id);
    });

  const updateSessionSettings = (input: UpdateSessionInput) =>
    Effect.gen(function* () {
      const current = yield* store.getSession(input.sessionId);
      const patch = {
        ...(input.title !== undefined && input.title.trim() ? { title: input.title.trim() } : {}),
        ...(input.model !== undefined ? { model: input.model?.trim() || null } : {}),
        ...(input.effort !== undefined ? { effort: input.effort?.trim() || null } : {}),
        ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
      };
      const session = yield* updateSession(input.sessionId, patch);
      if (
        session.model !== current.model ||
        session.effort !== current.effort ||
        session.runtimeMode !== current.runtimeMode
      ) {
        yield* reopenWithNewSettings(session.id);
      }
      return session;
    });

  // Model lists come from the provider CLIs; cache them for a while.
  const modelLists = Object.fromEntries(
    yield* Effect.forEach(Object.values(providers), (provider) =>
      Effect.cachedInvalidateWithTTL(provider.listModels, Duration.minutes(30)).pipe(
        Effect.map((cached) => [provider.kind, cached] as const),
      ),
    ),
  ) as unknown as Record<ProviderKind, readonly [(typeof providers)[ProviderKind]["listModels"], Effect.Effect<void>]>;

  const closeSession = (id: SessionId) =>
    Effect.gen(function* () {
      generations.delete(id);
      yield* closeLive(id);
      const session = yield* store.getSession(id);
      if (session.status !== "idle") yield* updateSession(id, { status: "idle" });
    });

  const reflect = (id: SessionId): Effect.Effect<Session, ApolloError> =>
    Effect.gen(function* () {
      const source = yield* store.getSession(id);
      if (source.role === "reflection") return yield* invalid("cannot reflect on a reflection");
      const transcript = transcriptForReflection(yield* store.listEvents(id, 0));
      if (transcript.length === 0) return yield* invalid("session has no transcript yet");
      yield* store.resetReflectionCounter(id);
      const reflection = yield* createSession({
        botId: source.botId,
        title: `Reflect: ${source.title}`,
        provider: { provider: source.provider, ...(source.model ? { model: source.model } : {}) },
        cwd: source.cwd,
        role: "reflection",
        parentSessionId: source.id,
      });
      yield* send(reflection.id, reflectionPrompt(source, transcript), "system");
      return reflection;
    });

  yield* store.resetLiveStatuses;
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...live.keys()], closeLive, { discard: true }),
  );

  return {
    changes: Stream.fromPubSub(changes),

    snapshot: Effect.all({ bots: store.listBots, sessions: store.listSessions(), usageToday: store.usageOn() }),

    /** Replays persisted events after `afterSeq`, then follows live ones without gaps. */
    events: (id: SessionId, afterSeq: number): Stream.Stream<SessionEvent, ApolloError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* store.getSession(id);
          const subscription = yield* PubSub.subscribe(events);
          const history = yield* store.listEvents(id, afterSeq);
          const lastSeq = history.at(-1)?.seq ?? afterSeq;
          return Stream.concat(
            Stream.fromIterable(history),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((e) => e.sessionId === id && (e.seq === 0 || e.seq > lastSeq)),
            ),
          );
        }),
      ),

    createBot: (input: CreateBotInput) =>
      Effect.gen(function* () {
        if (input.name.trim().length === 0) return yield* invalid("bot name is required");
        const now = Date.now();
        const bot: Bot = {
          id: newId<BotId>("bot"),
          name: input.name.trim(),
          instructions: input.instructions,
          cwd: input.cwd,
          main: input.main,
          defaultWorker: input.defaultWorker,
          runtimeMode: input.runtimeMode,
          autoLearn: input.autoLearn,
          limits: input.limits ?? DEFAULT_BOT_LIMITS,
          pausedReason: null,
          mainSessionId: newId<SessionId>("ses"),
          createdAt: now,
          updatedAt: now,
        };
        yield* store.insertBot(bot);
        yield* publish({ _tag: "BotUpserted", bot });
        yield* createSession({
          id: bot.mainSessionId,
          botId: bot.id,
          title: bot.name,
          provider: bot.main,
          role: "main",
          parentSessionId: null,
        });
        return bot;
      }),

    updateBot: (input: UpdateBotInput) =>
      Effect.gen(function* () {
        const current = yield* store.getBot(input.botId);
        const bot: Bot = {
          ...current,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.main !== undefined ? { main: { ...input.main, provider: current.main.provider } } : {}),
          ...(input.defaultWorker !== undefined ? { defaultWorker: input.defaultWorker } : {}),
          ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
          ...(input.autoLearn !== undefined ? { autoLearn: input.autoLearn } : {}),
          ...(input.limits !== undefined ? { limits: input.limits } : {}),
          updatedAt: Date.now(),
        };
        yield* store.updateBot(bot);
        yield* publish({ _tag: "BotUpserted", bot });
        // The orchestrator follows the bot's main model; sessions without their own
        // runtime mode follow the bot's.
        if (input.main !== undefined) {
          yield* updateSessionSettings({
            sessionId: bot.mainSessionId,
            model: bot.main.model ?? null,
            effort: bot.main.effort ?? null,
          });
        }
        if (bot.runtimeMode !== current.runtimeMode) {
          for (const session of yield* store.listSessions(bot.id)) {
            if (session.runtimeMode === null) yield* reopenWithNewSettings(session.id);
          }
        }
        return bot;
      }),

    deleteBot: (botId: BotId) =>
      Effect.gen(function* () {
        const sessions = yield* store.listSessions(botId);
        yield* Effect.forEach(sessions, (s) => closeSession(s.id), { discard: true });
        yield* store.deleteBot(botId);
        yield* Effect.sync(() =>
          rmSync(pluginDir(config.dataDir, botId), { recursive: true, force: true }),
        ).pipe(Effect.ignore);
        yield* publish({ _tag: "BotDeleted", botId });
      }),

    createSession: (input: {
      readonly botId: BotId;
      readonly title: string;
      readonly provider: ProviderSelection;
      readonly cwd?: string | undefined;
      readonly prompt?: string | undefined;
      readonly parentSessionId?: SessionId | null;
      readonly notifyParent?: boolean;
      readonly author?: MessageAuthor;
    }) =>
      Effect.gen(function* () {
        const session = yield* createSession({
          botId: input.botId,
          title: input.title,
          provider: input.provider,
          cwd: input.cwd,
          role: "worker",
          parentSessionId: input.parentSessionId ?? null,
        });
        if (input.notifyParent && session.parentSessionId) yield* store.setNotifyParent(session.id, true);
        if (input.prompt && input.prompt.trim().length > 0) {
          yield* send(session.id, input.prompt, input.author ?? "user");
        }
        return session;
      }),

    send,

    interrupt: (id: SessionId) =>
      Effect.suspend(() => {
        const entry = live.get(id);
        return entry
          ? entry.provider.interrupt.pipe(Effect.mapError((e) => providerFailure(e.message)))
          : Effect.void;
      }),

    respondApproval: (id: SessionId, requestId: string, decision: ApprovalDecision) =>
      Effect.suspend(() => {
        const entry = live.get(id);
        return entry
          ? entry.provider
              .respondApproval(requestId, decision)
              .pipe(Effect.mapError((e) => providerFailure(e.message)))
          : Effect.fail(invalid("session is not running"));
      }),

    respondInput: (id: SessionId, requestId: string, response: InputResponse) =>
      Effect.suspend(() => {
        const entry = live.get(id);
        return entry
          ? entry.provider
              .respondInput(requestId, response)
              .pipe(Effect.mapError((e) => providerFailure(e.message)))
          : Effect.fail(invalid("session is not running"));
      }),

    closeSession,
    updateSessionSettings,
    guardWorkerCapacity,

    /** Interrupts everything the bot is doing and pauses its automated work. */
    stopBot: (botId: BotId) =>
      Effect.gen(function* () {
        const bot = yield* pauseBot(botId, "you stopped it");
        yield* interruptBot(botId);
        return bot;
      }),

    /** Publishes a change to every connected client. */
    publish,
    /** Notes that the orchestrator's next turn was started by a schedule, not by a runaway loop. */
    resetAutonomy: (botId: BotId) => Effect.sync(() => void autonomousTurns.delete(botId)),
    appendNotice: (id: SessionId, level: "info" | "warning" | "error", message: string) =>
      appendEvent(id, { _tag: "Notice", level, message }).pipe(Effect.asVoid),
    isBusy: (id: SessionId) => Effect.map(store.getSession(id), (s) => isBusy(s.status)),
    busyWorkers: (botId: BotId) =>
      Effect.map(busySessions(botId), (sessions) => sessions.filter((s) => s.role === "worker").length),

    resumeBot: (botId: BotId) =>
      Effect.gen(function* () {
        const current = yield* store.getBot(botId);
        const reason = overBudget(current, yield* store.usageToday(botId));
        if (reason !== null) return yield* invalid(`${current.name} cannot resume: ${reason}. Raise the budget first.`);
        autonomousTurns.delete(botId);
        const bot = yield* store.setBotPaused(botId, null);
        yield* publish({ _tag: "BotUpserted", bot });
        return bot;
      }),
    listModels: (provider: ProviderKind) =>
      modelLists[provider][0].pipe(Effect.mapError((error) => providerFailure(error.message))),
    /** Forgets cached model lists, after credentials or endpoints change. */
    refreshModels: Effect.forEach(Object.values(modelLists), ([, invalidate]) => invalidate, { discard: true }),

    deleteSession: (id: SessionId) =>
      Effect.gen(function* () {
        const session = yield* store.getSession(id);
        if (session.role === "main") return yield* invalid("delete the bot to remove its main session");
        yield* closeSession(id);
        yield* store.deleteSession(id);
        yield* publish({ _tag: "SessionDeleted", sessionId: id });
      }),

    reflect,

    /** Waits until the session is no longer busy, or the timeout elapses. */
    waitUntilIdle: (id: SessionId, timeout: Duration.Input) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const current = yield* store.getSession(id);
        if (!isBusy(current.status)) return { session: current, timedOut: false };
        const settled = yield* Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (c): c is Extract<AppChange, { _tag: "SessionUpserted" }> =>
              c._tag === "SessionUpserted" && c.session.id === id && !isBusy(c.session.status),
          ),
          Stream.runHead,
          Effect.timeoutOption(timeout),
        );
        return Option.isSome(settled) && Option.isSome(settled.value)
          ? { session: settled.value.value.session, timedOut: false }
          : { session: yield* store.getSession(id), timedOut: true };
      }).pipe(Effect.scoped),

    /** Whether the session has a running provider process. */
    isLive: (id: SessionId) => Effect.sync(() => live.has(id)),

    /** Resolves an MCP bearer token to the session it was issued to. */
    resolveToken: (token: string) => Effect.sync(() => tokens.get(token)),

    publishMemoryChanged: (botId: BotId | null) => publish({ _tag: "MemoryChanged", botId }),
    /** Announces a skill change and refreshes the native skill folders. */
    publishSkillChanged: (botId: BotId | null) =>
      Effect.andThen(publish({ _tag: "SkillChanged", botId }), resyncSkills(botId)),
  };
});

export class SessionManager extends Context.Service<
  SessionManager,
  Effect.Success<typeof make>
>()("apollo/SessionManager") {}

export const layer = Layer.effect(SessionManager, make);
