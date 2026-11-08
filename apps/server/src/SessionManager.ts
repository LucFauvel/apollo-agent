import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { type ExplainItem, makeChangeTracker } from "./changes/Tracker.ts";
import { unrequested } from "./changes/requested.ts";
import { Database } from "./Database.ts";
import { isAbsolute, join, relative } from "node:path";
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
  randomAvatar,
  type SessionWorktree,
  type AttachmentRef,
  type ConnectorInfo,
  type SlashCommand,
} from "@apollo/contracts";
import {
  makeClaudeProvider,
  makeAcpProviders,
  makeCodexProvider,
  makeLlamaCppProvider,
  makeMuseProvider,
  makePiProvider,
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
import { AppSettings } from "./AppSettings.ts";
import { findAttachment, removeAttachments } from "./attachments.ts";
import { createWorktree, type FinishAction, finishWorktree, retireWorktree, worktreeStatus } from "./worktrees/Git.ts";
import { accountEnvironment } from "./Accounts.ts";
import { ServerConfig } from "./Config.ts";
import {
  buildInstructions,
  MCP_SERVER_NAME,
  reflectionPrompt,
  transcriptForReflection,
  withoutExcluded,
} from "./Instructions.ts";
import { pluginDir, syncSkills } from "./SkillSync.ts";
import { newId, Store } from "./Store.ts";

/** Commands Apollo handles itself, whatever the provider. */
const APOLLO_COMMANDS: ReadonlyArray<Omit<SlashCommand, "source">> = [
  { name: "compact", description: "Summarize the conversation so far to free context", argumentHint: "[what to keep]" },
  { name: "clear", description: "Start a fresh conversation in this session (memory and skills stay)", argumentHint: "" },
  { name: "stop", description: "Stop the current turn", argumentHint: "" },
  { name: "reflect", description: "Save what this session learned to memory now", argumentHint: "" },
];

/** A reflection still running after this long is given up, so the next in line can run. */
const REFLECTION_TIMEOUT = "20 minutes";

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
      // Third-party agents: their CLIs come from PATH; Antigravity installs into Apollo's data folder.
      ...makeAcpProviders({ stateDir: join(config.dataDir, "agents") }),
      muse: makeMuseProvider(),
      pi: makePiProvider({ stateDir: join(config.dataDir, "agents") }),
      llamacpp: makeLlamaCppProvider({
        executable: config.claudeExecutable,
        // Auto mode's reviewer: a small local model the user picked (asks when there is none).
        review: (call) => localModels.review(call),
        allowSubagents: Effect.map(settings.read, ({ llamacpp }) => llamacpp.allowSubagents),
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

/** How long a full semantic diff may take before it is stopped. */
const SEMANTIC_DIFF_TIMEOUT = Duration.seconds(120);
const providerFailure = (message: string) => new ApolloError({ code: "provider", message });

/** A turn is under way (not just the process starting). */
const inTurn = (status: SessionStatus) => status === "running" || status === "waiting-approval";

const isBusy = (status: SessionStatus) =>
  status === "starting" || status === "running" || status === "waiting-approval";

const make = Effect.gen(function* () {
  const store = yield* Store;
  /** What each turn changes in git repositories (see changes/Tracker.ts). */
  const changeTracker = makeChangeTracker(yield* Database, homedir());
  const config = yield* ServerConfig;
  const providers = yield* Providers;
  const appSettings = yield* AppSettings;
  // Absent in tests that run without local models.
  const localModels = yield* Effect.serviceOption(LocalModels);
  const managerScope = yield* Effect.scope;

  /** Expands `~` and creates the bot's workspace folder if it does not exist yet. */
  const prepareWorkspace = (path: string) =>
    Effect.gen(function* () {
      const cwd = appSettings.expand(path);
      if (!cwd) return yield* invalid("a workspace folder is required");
      if (!isAbsolute(cwd)) return yield* invalid(`use a full path for the workspace: ${cwd}`);
      yield* Effect.try({
        try: () => mkdirSync(cwd, { recursive: true }),
        catch: (error) => invalid(`cannot create ${cwd}: ${(error as Error).message}`),
      });
      return cwd;
    });

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
          case "ContextUsage": {
            yield* updateSession(id, { context: { used: emission.used, window: emission.window } });
            return;
          }
          case "Exited": {
            // Ignore exits from a session we already replaced or closed on purpose.
            if (generations.get(id) !== generation) return;
            yield* background(
              Effect.gen(function* () {
                yield* closeLive(id);
                const session = yield* store.getSession(id);
                // A reflection whose agent died will not answer: drop it and let the next one run.
                if (session.role === "reflection") return yield* endReflection(id);
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
            if (event._tag === "AssistantDelta" || event._tag === "ReasoningDelta" || event._tag === "ToolPending" || event._tag === "Compacting") {
              // Live-only (seq 0); the final AssistantMessage / Reasoning / ToolStarted is persisted.
              yield* PubSub.publish(events, { sessionId: id, seq: 0, at: Date.now(), event });
              return;
            }
            const stored = yield* appendEvent(id, event);
            switch (event._tag) {
              case "TurnStarted": {
                yield* updateSession(id, { status: "running" });
                // Snapshot the session's repositories, to see what this turn changes.
                const session = yield* store.getSession(id);
                if (session.role !== "reflection") {
                  yield* background(Effect.promise(() => changeTracker.turnStarted(id, stored.seq, session.cwd)));
                }
                return;
              }
              case "ToolStarted":
                yield* background(Effect.promise(() => changeTracker.toolStarted(id, event.summary)));
                return;
              case "ApprovalRequested":
              case "InputRequested": {
                // A reflection works alone: whatever it asks is declined, and never reaches the user.
                if ((yield* store.getSession(id)).role === "reflection") {
                  const entry = live.get(id);
                  if (entry) {
                    yield* (
                      event._tag === "ApprovalRequested"
                        ? entry.provider.respondApproval(event.requestId, "decline")
                        : entry.provider.respondInput(event.requestId, { action: "decline", values: {} })
                    ).pipe(Effect.ignore);
                  }
                  yield* Effect.logWarning(`reflection ${id} asked for ${event._tag === "ApprovalRequested" ? "approval" : "input"}; declined`);
                  return;
                }
                yield* updateSession(id, { status: "waiting-approval" });
                return;
              }
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

  /**
   * Opens the session's agent process if needed. `forTurn`: the caller already marked the
   * session as working (a message is being sent), so opening leaves the status alone.
   */
  const ensureOpen = (id: SessionId, forTurn = false): Effect.Effect<LiveSession, ApolloError> =>
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
        const { projectFolders } = yield* appSettings.read;
        const token = randomUUID();
        const generation = {};
        generations.set(id, generation);
        const scope = yield* Scope.make();

        if (!forTurn) yield* updateSession(id, { status: "starting" });
        const opened = yield* providers[session.provider]
          .open(
            {
              cwd: session.cwd,
              // A bot on another account runs the CLI in that account's folder.
              ...(session.provider === "claude" && bot.claudeAccountId
                ? { environment: accountEnvironment(config.dataDir, "claude", bot.claudeAccountId) }
                : session.provider === "codex" && bot.codexAccountId
                  ? { environment: accountEnvironment(config.dataDir, "codex", bot.codexAccountId) }
                  : {}),
              model: session.model,
              effort: session.effort,
              resumeId: session.resumeId,
              instructions: buildInstructions({
                bot,
                session,
                core,
                skills,
                projectFolders,
                // Lists come from this machine's logins: not this bot's when it runs on another account.
                connectors: Object.fromEntries(
                  [...connectorCache]
                    .filter(([kind]) => !(kind === "claude" && bot.claudeAccountId) && !(kind === "codex" && bot.codexAccountId))
                    .map(([kind, { list }]) => [kind, list]),
                ),
              }),
              extraDirectories: projectFolders,
              runtimeMode: session.runtimeMode ?? bot.runtimeMode,
              readOnly: session.role === "reflection",
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
        if (!forTurn) yield* updateSession(id, { status: "idle" });
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

  /**
   * The changes part of a worker's report: the files (detected by Apollo) and the worker's
   * explanations of them (from apollo_explain_changes), if it gave any.
   */
  const changesReport = (
    repos: ReadonlyArray<{ name: string; files: ReadonlyArray<{ path: string; status: string; additions: number | null; deletions: number | null }> }>,
    notes: ReadonlyArray<{ repo: string; path: string; symbol: string; text: string }>,
  ) => {
    if (repos.length === 0 && notes.length === 0) return null;
    const lines: Array<string> = [];
    for (const repo of repos) {
      const shown = repo.files.slice(0, 25);
      lines.push(`Files it changed in ${repo.name}:`);
      for (const f of shown) {
        const counts = f.additions === null ? "binary" : `+${f.additions} -${f.deletions ?? 0}`;
        lines.push(`- ${f.path} (${f.status}, ${counts})`);
      }
      if (repo.files.length > shown.length) lines.push(`- and ${repo.files.length - shown.length} more`);
    }
    const summary = notes.find((n) => n.path === "");
    const fileNotes = notes.filter((n) => n.path !== "");
    if (summary || fileNotes.length > 0) {
      lines.push("Its explanation of the changes:");
      if (summary) lines.push(summary.text);
      for (const n of fileNotes) lines.push(`- ${n.path}${n.symbol ? ` › ${n.symbol}` : ""}: ${n.text}`);
    }
    return lines.join("\n");
  };

  const onTurnCompleted = (id: SessionId, event: Extract<AgentEvent, { _tag: "TurnCompleted" }>) =>
    Effect.gen(function* () {
      const { session, turnsSinceReflection } = yield* store.recordTurn(id);
      yield* background(deliverMentionReplies(session, event));
      // What the turn changed in git repositories, shown in the conversation (deterministic).
      const turnChanges = yield* Effect.promise(() => changeTracker.turnCompleted(id).catch(() => null)).pipe(
        Effect.timeoutOrElse({ duration: "90 seconds", orElse: () => Effect.succeed(null) }),
      );
      if (turnChanges && turnChanges.repos.length > 0) {
        yield* appendEvent(id, { _tag: "FilesChanged", repos: turnChanges.repos });
        yield* publish({ _tag: "ChangesUpdated", sessionId: id, botId: session.botId });
      }
      yield* updateSession(id, { status: "idle" });
      if (pendingReopen.delete(id)) yield* reopenWithNewSettings(id);

      if (session.role === "reflection") {
        // A reflection is one-shot and only matters for what it saved (memories and
        // skill proposals keep no link to it): remove it once it has answered.
        if (event.outcome !== "completed") {
          yield* Effect.logWarning(`reflection ${id} ended ${event.outcome}${event.error ? `: ${event.error}` : ""}`);
        }
        yield* background(endReflection(id));
        return;
      }

      if (session.parentSessionId !== null && (yield* store.notifiesParent(id))) {
        const report = [
          `[Apollo] Worker session "${session.title}" (${session.id}, ${session.provider}) finished a turn: ${event.outcome}.`,
          event.error ? `Error: ${event.error}` : null,
          session.lastMessage ? `Its last message:\n${session.lastMessage}` : "It produced no final message.",
          turnChanges ? changesReport(turnChanges.repos, changeTracker.turnNotes(id, turnChanges.seq)) : null,
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

  const send = (
    id: SessionId,
    text: string,
    author: MessageAuthor = "user",
    attachments: ReadonlyArray<AttachmentRef> = [],
    /** A `peer` message's bot, and what the agent reads when it differs from what the chat shows. */
    extra: { readonly fromBotId?: BotId; readonly agentText?: string } = {},
  ) =>
    Effect.gen(function* () {
      if (text.trim().length === 0 && attachments.length === 0) return yield* invalid("message is empty");
      const files = attachments.map((ref) => findAttachment(config.dataDir, id, ref.id));
      if (files.some((f) => f === null)) return yield* invalid("an attachment is missing; upload it again");
      const target = yield* store.getSession(id);
      if (target.provider === "llamacpp" && Option.isSome(localModels)) {
        const blocking = yield* localModels.value.downloadBlocking(target.model);
        if (blocking) {
          return yield* invalid(`${blocking} is still downloading. Send the message once the download finishes.`);
        }
      }
      if (author === "user") {
        // The user is back in the loop.
        if (target.role === "main") autonomousTurns.delete(target.botId);
        botTalk.delete(id);
      } else {
        yield* guardAutomated(target);
      }
      // The message shows, and the session reads as working, before the agent's process
      // opens: starting Claude Code or loading a local model can take a while.
      yield* appendEvent(id, {
        _tag: "UserMessage",
        text,
        author,
        ...(attachments.length > 0 ? { attachments: files.map((f) => ({ id: f!.id, name: f!.name, mime: f!.mime, size: f!.size })) } : {}),
        ...(extra.fromBotId ? { fromBotId: extra.fromBotId } : {}),
      });
      // Mark busy before the provider acknowledges the turn, so a caller that
      // immediately waits on this session (e.g. apollo_wait_session) cannot see
      // a stale "idle". TurnCompleted flips it back.
      const before = yield* store.getSession(id);
      if (!isBusy(before.status)) yield* updateSession(id, { status: "running" });
      // `@OtherBot` in the user's message points the agent at that bot: it reads who that is.
      const agentText = extra.agentText ?? (author === "user" ? yield* withMentionNote(target, text) : text);
      // A failure to open posts its own notice and marks the session as errored.
      const entry = yield* ensureOpen(id, true);
      yield* entry.provider.send(agentText, files.map((f) => ({ path: f!.path, name: f!.name, mime: f!.mime, size: f!.size }))).pipe(
        Effect.mapError((error) => providerFailure(error.message)),
        Effect.tapError(() => updateSession(id, { status: "idle" }).pipe(Effect.ignore)),
      );
    });

  // --- other bots ------------------------------------------------------------
  // The user can tag another of their bots with `@Name`: the agent is told who that is.
  // Bots write to each other with apollo_ask_bot; answers come back as `peer` messages.

  /** Conversations waiting for another bot's answer (apollo_ask_bot), by that bot's main session. */
  const mentionReplies = new Map<SessionId, Array<{ fromSessionId: SessionId; kind: "ask" }>>();
  /** Messages a conversation sent to other bots since the user last wrote in it. */
  const botTalk = new Map<SessionId, number>();
  /** How many messages bots may exchange before the user takes part again. */
  const MAX_BOT_TALK = 6;

  const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** The bots a message tags (`@Name`, any case), other than the conversation's own. */
  const mentionedBots = (text: string, ownBotId: BotId) =>
    Effect.map(store.listBots, (bots) =>
      bots.filter(
        (bot) =>
          bot.id !== ownBotId && new RegExp(`(^|[^\\w@])@${escapeRegExp(bot.name)}(?![\\w-])`, "i").test(text),
      ),
    );

  /**
   * The user's message as the agent reads it: with a note on the bots it tags. A tag is a
   * reference ("talk to @Vega about this"), not a message to that bot: the agent decides
   * whether to write to it with apollo_ask_bot.
   */
  const withMentionNote = (session: Session, text: string) =>
    Effect.gen(function* () {
      const bots = yield* mentionedBots(text, session.botId);
      if (bots.length === 0) return text;
      const lines = bots.map((bot) => {
        const about = bot.instructions.trim().split("\n")[0]?.slice(0, 160);
        return `- @${bot.name}: another of the user's bots${about ? ` (${about})` : ""}`;
      });
      const canAsk = session.role === "main";
      return [
        text,
        "",
        `[Apollo] The user tagged ${bots.length === 1 ? "another bot" : "other bots"}:`,
        ...lines,
        canAsk
          ? "Tags say who the user means; nothing was sent to them. Write to one with `apollo_ask_bot` if the task needs it."
          : "Tags say who the user means; nothing was sent to them. Your orchestrator can write to them with `apollo_ask_bot`.",
      ].join("\n");
    });

  /**
   * Where `from` talks to `bot`: a side conversation of `bot` (not its main thread), one per
   * pair of bots, reused for later messages. It runs on the bot's orchestrator model.
   */
  const botChannel = (bot: Bot, from: Bot) =>
    Effect.gen(function* () {
      const title = `Conversation with ${from.name}`;
      const existing = (yield* store.listSessions(bot.id)).find(
        (s) => s.role === "worker" && s.parentSessionId === null && s.title === title && s.status !== "closed",
      );
      if (existing) return existing;
      return yield* createSession({ botId: bot.id, title, provider: bot.main, role: "worker", parentSessionId: null });
    });

  /**
   * A bot's orchestrator writes to another of the user's bots (`apollo_ask_bot`). The message
   * goes to a side conversation of that bot (from the asking bot); its answer is sent back.
   * Bots can exchange a few messages before the user has to take part again.
   */
  const askBot = (fromId: SessionId, target: string, message: string): Effect.Effect<{ bot: string }, ApolloError> =>
    Effect.gen(function* () {
      const from = yield* store.getSession(fromId);
      if (from.role !== "main") return yield* invalid("only a bot's orchestrator can write to other bots");
      const fromBot = yield* store.getBot(from.botId);
      const wanted = target.replace(/^@/, "").trim().toLowerCase();
      const bot = (yield* store.listBots).find((b) => b.id === target || b.name.toLowerCase() === wanted);
      if (!bot) return yield* invalid(`no bot named "${target}"; apollo_list_bots lists them`);
      if (bot.id === fromBot.id) return yield* invalid("that is you");
      if (!message.trim()) return yield* invalid("the message is empty");
      const sent = (botTalk.get(fromId) ?? 0) + 1;
      if (sent > MAX_BOT_TALK) {
        return yield* invalid(`you already sent ${MAX_BOT_TALK} messages to other bots since the user last wrote; check with the user first`);
      }
      botTalk.set(fromId, sent);
      // Not in the other bot's main conversation: in a side conversation for this pair of bots.
      const channel = yield* botChannel(bot, fromBot);
      mentionReplies.set(channel.id, [...(mentionReplies.get(channel.id) ?? []), { fromSessionId: fromId, kind: "ask" }]);
      yield* send(channel.id, message.trim(), "peer", [], {
        fromBotId: fromBot.id,
        agentText: [
          `[Apollo] ${fromBot.name}, another of the user's bots, writes to you:`,
          message.trim(),
          "",
          `Your final message this turn is sent back to ${fromBot.name}. Answer directly; ask the user only if you must.`,
        ].join("\n"),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() =>
            mentionReplies.set(
              channel.id,
              (mentionReplies.get(channel.id) ?? []).filter((w) => !(w.fromSessionId === fromId && w.kind === "ask")),
            ),
          ),
        ),
      );
      return { bot: bot.name };
    });

  /** A bot that was written to finished its turn: send its answer back. */
  const deliverMentionReplies = (session: Session, event: Extract<AgentEvent, { _tag: "TurnCompleted" }>): Effect.Effect<void, ApolloError> =>
    Effect.gen(function* () {
      const waiting = mentionReplies.get(session.id);
      if (!waiting?.length) return;
      mentionReplies.delete(session.id);
      const bot = yield* store.getBot(session.botId);
      const answer = session.lastMessage?.trim();
      for (const { fromSessionId } of waiting) {
        if (event.outcome !== "completed" || !answer || answer === "[SILENT]") {
          yield* appendEvent(fromSessionId, {
            _tag: "Notice",
            level: "warning",
            message: `${bot.name} did not answer${event.outcome !== "completed" ? ` (its turn ${event.outcome})` : ""}.`,
          });
          continue;
        }
        yield* send(fromSessionId, answer, "peer", [], {
          fromBotId: bot.id,
          agentText: `[Apollo] ${bot.name}, another of the user's bots, answered your message:\n${answer}`,
        }).pipe(
          Effect.catchTag("ApolloError", (error) =>
            appendEvent(fromSessionId, { _tag: "Notice", level: "warning", message: `${bot.name} answered, but it could not be posted: ${error.message}` }),
          ),
        );
      }
    });

  const createSession = (input: {
    readonly botId: BotId;
    readonly title: string;
    readonly provider: ProviderSelection;
    readonly cwd?: string | undefined;
    readonly role: SessionRole;
    readonly parentSessionId: SessionId | null;
    readonly id?: SessionId;
    readonly isolation?: "shared" | "worktree" | undefined;
  }) =>
    Effect.gen(function* () {
      const bot = yield* store.getBot(input.botId);
      const now = Date.now();
      const id = input.id ?? newId<SessionId>("ses");
      let cwd = input.cwd?.trim() ? appSettings.expand(input.cwd) : bot.cwd;
      let worktree: SessionWorktree | null = null;
      if (input.isolation === "worktree") {
        const created = yield* Effect.tryPromise({
          try: () => createWorktree(config.dataDir, id, cwd, input.title),
          catch: (error) => invalid(`could not create a worktree: ${(error as Error).message}`),
        });
        worktree = created.worktree;
        cwd = created.cwd;
      }
      const session = yield* store.insertSession({
        id,
        botId: bot.id,
        role: input.role,
        parentSessionId: input.parentSessionId,
        title: input.title.trim() || "Untitled session",
        provider: input.provider.provider,
        model: input.provider.model ?? null,
        effort: input.provider.effort ?? null,
        runtimeMode: null,
        cwd,
        worktree,
        context: null,
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

  // Connectors and MCP servers each provider's sessions can reach, for the orchestrator.
  // Listing asks the CLIs without a conversation (no tokens) but takes seconds: cached.
  const connectorCache = new Map<ProviderKind, { readonly at: number; readonly list: ReadonlyArray<ConnectorInfo> }>();
  const CONNECTORS_TTL_MS = 30 * 60_000;
  const listConnectors = (kind: ProviderKind, refresh = false) =>
    Effect.gen(function* () {
      const cached = connectorCache.get(kind);
      if (cached && !refresh && Date.now() - cached.at < CONNECTORS_TTL_MS) return cached.list;
      const list = providers[kind].listConnectors
        ? yield* providers[kind].listConnectors!.pipe(Effect.mapError((error) => providerFailure(error.message)))
        : [];
      connectorCache.set(kind, { at: Date.now(), list });
      return list;
    });
  yield* Effect.forEach(Object.keys(providers) as Array<ProviderKind>, (kind) =>
    listConnectors(kind).pipe(Effect.catch((error) => Effect.logInfo(`could not list ${kind} connectors: ${error.message}`))),
  ).pipe(Effect.delay(Duration.seconds(3)), Effect.forkIn(managerScope));

  /** Closes a session's process and deletes it with its log (a worktree's branch is kept). */
  const removeSession = (id: SessionId) =>
    Effect.gen(function* () {
      yield* closeSession(id);
      const session = yield* store.getSession(id);
      removeAttachments(config.dataDir, id);
      if (session.worktree) {
        yield* Effect.tryPromise(() => retireWorktree(session.worktree!)).pipe(
          Effect.catch((error) => Effect.logWarning(`could not remove the worktree of ${id}`, error)),
        );
      }
      yield* store.deleteSession(id);
      yield* publish({ _tag: "SessionDeleted", sessionId: id });
      // However a running reflection goes (answered, stuck, deleted), the next may start.
      if (reflecting === id) yield* nextReflection;
    });

  const closeSession = (id: SessionId) =>
    Effect.gen(function* () {
      generations.delete(id);
      yield* closeLive(id);
      const session = yield* store.getSession(id);
      if (session.status !== "idle") yield* updateSession(id, { status: "idle" });
    });

  const interrupt = (id: SessionId) =>
    Effect.suspend(() => {
      const entry = live.get(id);
      return entry ? entry.provider.interrupt.pipe(Effect.mapError((e) => providerFailure(e.message))) : Effect.void;
    });

  // --- reflection ---------------------------------------------------------
  // One reflection runs at a time (they are full agent sessions, and several at once write
  // to the same memories). Others wait in line, once per source session, and start in turn.

  /** The running reflection: "starting" while it is being created, else its session id. */
  let reflecting: SessionId | "starting" | null = null;
  const reflectionQueue: Array<SessionId> = [];

  const transcriptOf = (id: SessionId) =>
    Effect.gen(function* () {
      const source = yield* store.getSession(id);
      if (source.role === "reflection") return yield* invalid("cannot reflect on a reflection");
      const transcript = transcriptForReflection(
        withoutExcluded(yield* store.listEvents(id, 0), yield* store.memoryExclusions(id)),
      );
      if (transcript.length === 0) return yield* invalid("session has no transcript yet");
      return { source, transcript };
    });

  /** Starts a reflection on `id`; the caller holds the slot (`reflecting` is "starting"). */
  const startReflection = (id: SessionId): Effect.Effect<Session, ApolloError> =>
    Effect.gen(function* () {
      // Read when it starts, so a queued reflection covers the turns that came in meanwhile.
      const { source, transcript } = yield* transcriptOf(id);
      yield* store.resetReflectionCounter(id);
      const reflection = yield* createSession({
        botId: source.botId,
        title: `Reflect: ${source.title}`,
        provider: { provider: source.provider, ...(source.model ? { model: source.model } : {}) },
        cwd: source.cwd,
        role: "reflection",
        parentSessionId: source.id,
      });
      reflecting = reflection.id;
      // A reflection that never answers must not hold the line forever.
      yield* background(
        Effect.sleep(REFLECTION_TIMEOUT).pipe(
          Effect.andThen(Effect.suspend(() => (reflecting === reflection.id ? endReflection(reflection.id) : Effect.void))),
        ),
      );
      yield* send(reflection.id, reflectionPrompt(source, transcript), "system");
      return reflection;
    }).pipe(Effect.tapError(() => Effect.suspend(() => nextReflection)));

  /** Frees the slot and starts the next reflection in line, if any. */
  const nextReflection: Effect.Effect<void> = Effect.suspend(() => {
    reflecting = null;
    const next = reflectionQueue.shift();
    if (next === undefined) return Effect.void;
    reflecting = "starting";
    // startReflection moves on to the one after when this one cannot start.
    return background(startReflection(next));
  });

  /** Removes a finished (or stuck) reflection; removing it lets the next one start. */
  const endReflection = (id: SessionId): Effect.Effect<void> =>
    removeSession(id).pipe(
      Effect.catchCause((cause) => Effect.logWarning(`could not remove reflection ${id}`, cause)),
      Effect.andThen(Effect.suspend(() => (reflecting === id ? nextReflection : Effect.void))),
    );

  /** A reflection the user asked for: says so in the session when it has to wait. */
  const requestReflection = (id: SessionId) =>
    reflect(id).pipe(
      Effect.tap((started) =>
        started === null
          ? appendEvent(id, { _tag: "Notice", level: "info", message: "Another reflection is running; this one starts when it is done." })
          : Effect.void,
      ),
    );

  /**
   * Reflects on a session now, or after the running reflection: the new reflection
   * session, or null when it waits in line.
   */
  const reflect = (id: SessionId): Effect.Effect<Session | null, ApolloError> =>
    Effect.gen(function* () {
      yield* transcriptOf(id); // Refuse right away what could never run.
      if (reflecting !== null) {
        if (!reflectionQueue.includes(id)) reflectionQueue.push(id);
        return null;
      }
      reflecting = "starting";
      return yield* startReflection(id);
    });

  // Without skill review, proposals left from before (or from review being on) are active.
  if (!(yield* appSettings.read).reviewSkills) yield* store.activateProposedSkills;
  yield* store.resetLiveStatuses;
  // Reflections remove themselves when done; clear any left from before (or cut short by a restart).
  for (const session of yield* store.listSessions()) {
    if (session.role === "reflection") yield* store.deleteSession(session.id);
  }
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...live.keys()], closeLive, { discard: true }),
  );

  return {
    changes: Stream.fromPubSub(changes),

    /** Every session's events as they happen (live only, no history). */
    liveEvents: Stream.fromPubSub(events),

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
        const cwd = yield* prepareWorkspace(input.cwd);
        const now = Date.now();
        const bot: Bot = {
          id: newId<BotId>("bot"),
          name: input.name.trim(),
          avatar: input.avatar ?? randomAvatar(),
          instructions: input.instructions,
          cwd,
          main: input.main,
          defaultWorker: input.defaultWorker,
          runtimeMode: input.runtimeMode,
          autoLearn: input.autoLearn,
          limits: input.limits ?? DEFAULT_BOT_LIMITS,
          claudeAccountId: input.claudeAccountId ?? null,
          codexAccountId: input.codexAccountId ?? null,
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
        const cwd = input.cwd !== undefined && input.cwd.trim() !== current.cwd ? yield* prepareWorkspace(input.cwd) : undefined;
        const bot: Bot = {
          ...current,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
          ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(input.main !== undefined ? { main: { ...input.main, provider: current.main.provider } } : {}),
          ...(input.defaultWorker !== undefined ? { defaultWorker: input.defaultWorker } : {}),
          ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
          ...(input.autoLearn !== undefined ? { autoLearn: input.autoLearn } : {}),
          ...(input.limits !== undefined ? { limits: input.limits } : {}),
          ...(input.claudeAccountId !== undefined ? { claudeAccountId: input.claudeAccountId } : {}),
          ...(input.codexAccountId !== undefined ? { codexAccountId: input.codexAccountId } : {}),
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
        // Claude and Codex sessions move to the other account (their conversations carry over).
        const moved = new Set([
          ...(bot.claudeAccountId !== current.claudeAccountId ? ["claude"] : []),
          ...(bot.codexAccountId !== current.codexAccountId ? ["codex"] : []),
        ]);
        if (moved.size > 0) {
          for (const session of yield* store.listSessions(bot.id)) {
            if (moved.has(session.provider)) yield* reopenWithNewSettings(session.id);
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

    /** Slash commands for a session: Apollo's own, then its harness's (which needs the session open; no tokens). */
    listCommands: (id: SessionId) =>
      Effect.gen(function* () {
        const own: Array<SlashCommand> = APOLLO_COMMANDS.map((c) => ({ ...c, source: "apollo" }));
        const entry = yield* ensureOpen(id).pipe(Effect.option);
        if (entry._tag === "None") return own;
        const theirs = yield* entry.value.provider.commands.pipe(Effect.orElseSucceed(() => []));
        const taken = new Set(own.map((c) => c.name));
        return [
          ...own,
          ...theirs.filter((c) => !taken.has(c.name)).map((c): SlashCommand => ({ ...c, source: "provider" })),
        ];
      }),

    /**
     * Runs `/name args` from the message box. Apollo's commands act on the session;
     * anything else goes to the agent's harness as a message (Claude Code custom commands, skills).
     */
    runCommand: (id: SessionId, name: string, args: string) =>
      Effect.gen(function* () {
        const session = yield* store.getSession(id);
        switch (name) {
          case "compact": {
            if (inTurn(session.status)) return yield* invalid("wait for the current turn to finish, then compact");
            const entry = yield* ensureOpen(id);
            yield* appendEvent(id, { _tag: "Notice", level: "info", message: "Compacting the conversation…" });
            yield* entry.provider.compact(args).pipe(Effect.mapError((error) => providerFailure(error.message)));
            return;
          }
          case "clear": {
            if (inTurn(session.status)) return yield* invalid("stop the current turn first (/stop)");
            // Under the session's lock: a process still starting (e.g. from listing commands)
            // finishes first and is then closed, so it cannot come back on the old conversation.
            yield* Semaphore.withPermit(
              lockFor(id),
              Effect.gen(function* () {
                yield* closeSession(id);
                yield* updateSession(id, { resumeId: null, context: null, status: "idle" });
              }),
            );
            // The chat starts over too; the earlier messages stay in the log for search and memory.
            yield* appendEvent(id, { _tag: "ConversationCleared" });
            return;
          }
          case "stop":
            return yield* interrupt(id);
          case "reflect":
            yield* requestReflection(id);
            return;
          default:
            return yield* send(id, `/${name}${args.trim() ? ` ${args.trim()}` : ""}`, "user");
        }
      }),

    /** A worker's worktree: its commits, uncommitted changes and diff summary. */
    // --- other bots ------------------------------------------------------------
    askBot,

    // --- changes -----------------------------------------------------------

    /** What a session changed (an orchestrator: with its workers'), per repository. */
    changesList: (id: SessionId) =>
      Effect.gen(function* () {
        const session = yield* store.getSession(id);
        const sessions =
          session.role === "main"
            ? [session, ...(yield* store.listSessions(session.botId)).filter((s) => s.id !== session.id && s.role !== "reflection")]
            : [session];
        const all = yield* Effect.promise(() =>
          Promise.all(sessions.map((s) => changeTracker.sessionChanges(s.id, s.role === "main" ? "Orchestrator" : s.title))),
        );
        return { sessions: all.filter((c) => c !== null) };
      }),

    /** One changed file of a session as a semantic diff (with `reportSeq`: of the full diff in that event). */
    changesFile: (id: SessionId, repo: string, path: string, reportSeq?: number) =>
      Effect.gen(function* () {
        yield* store.getSession(id);
        if (reportSeq !== undefined) {
          const event = yield* store.eventAt(id, reportSeq);
          const report = event?._tag === "FilesChanged" && event.repos[0]?.repo === repo ? event.report : undefined;
          if (!report) return yield* invalid(`There is no full diff of ${repo} at ${reportSeq} in this session`);
          const diff = yield* Effect.promise(() => changeTracker.reportFile(repo, report, path).catch(() => null));
          if (!diff) return yield* invalid(`${path} is not in this diff (or its snapshot is no longer in the repository)`);
          return diff;
        }
        const diff = yield* Effect.promise(() => changeTracker.file(id, repo, path));
        if (!diff) return yield* invalid(`${path} is not among this session's changes`);
        return diff;
      }),

    /**
     * The full semantic diff of a repository against its baseline, which the user asked for:
     * shown in the conversation as a card (a FilesChanged event with `report`), never sent to
     * the model. `request` quotes the user's message that started the running turn (see changes/requested.ts).
     */
    semanticDiff: (id: SessionId, input: { readonly repo?: string | undefined; readonly base?: string | undefined; readonly request: string }) =>
      Effect.gen(function* () {
        const session = yield* store.getSession(id);
        const refused = unrequested(yield* store.currentTurn(id), input.request);
        if (refused) return yield* invalid(`Not shown: ${refused}.`);
        const path = input.repo ? (isAbsolute(input.repo) ? input.repo : join(session.cwd, input.repo)) : session.cwd;
        // Hitting the bound interrupts this, which aborts the signal: the git processes are
        // killed and no further step starts.
        const result = yield* Effect.tryPromise({
          try: (signal) => changeTracker.report(path, input.base, signal),
          catch: (error) => invalid((error as Error).message),
        }).pipe(
          Effect.timeoutOrElse({
            duration: SEMANTIC_DIFF_TIMEOUT,
            orElse: () => Effect.fail(invalid("The diff took over two minutes and was stopped; try a closer base ref")),
          }),
        );
        const stored = yield* appendEvent(id, { _tag: "FilesChanged", repos: [result.repo], report: result.report });
        return { seq: stored.seq, ...result };
      }),

    /** A worker's explanation of the changes in its running turn. */
    explainChanges: (id: SessionId, summary: string, items: ReadonlyArray<ExplainItem>) =>
      Effect.gen(function* () {
        const session = yield* store.getSession(id);
        const result = yield* Effect.promise(() => changeTracker.explain(id, summary, items));
        yield* publish({ _tag: "ChangesUpdated", sessionId: id, botId: session.botId });
        return result;
      }),

    worktreeStatus: (id: SessionId) =>
      Effect.gen(function* () {
        const session = yield* store.getSession(id);
        if (!session.worktree) return yield* invalid(`${session.title} does not have its own worktree`);
        return yield* Effect.tryPromise({
          try: () => worktreeStatus(session.worktree!),
          catch: (error) => invalid((error as Error).message),
        });
      }),

    /** Merges, keeps (as a branch) or discards a worker's worktree; the session then works in the main checkout. */
    finishWorktree: (id: SessionId, action: FinishAction) =>
      Effect.gen(function* () {
        const session = yield* store.getSession(id);
        const worktree = session.worktree;
        if (!worktree) return yield* invalid(`${session.title} does not have its own worktree`);
        if (isBusy(session.status)) return yield* invalid(`${session.title} is still working; wait for it to finish its turn`);
        const result = yield* Effect.tryPromise({
          try: () => finishWorktree(worktree, action),
          catch: (error) => invalid((error as Error).message),
        });
        yield* closeSession(id);
        const sub = relative(worktree.path, session.cwd);
        const next = yield* updateSession(id, {
          worktree: null,
          cwd: sub && !sub.startsWith("..") ? join(worktree.repoPath, sub) : worktree.repoPath,
        });
        yield* appendEvent(id, { _tag: "Notice", level: "info", message: result.message });
        return { ...result, session: next };
      }),

    /** Keeps one message out of the bot's memory, or puts it back. */
    setMemoryExclusion: (sessionId: SessionId, seq: number, excluded: boolean) =>
      Effect.gen(function* () {
        const event = yield* store.eventAt(sessionId, seq);
        if (!event || (event._tag !== "UserMessage" && event._tag !== "AssistantMessage")) {
          return yield* invalid("only messages can be excluded from memory");
        }
        yield* store.setMemoryExclusion(sessionId, seq, excluded);
        // Recorded in the log too, so every open transcript shows it.
        yield* appendEvent(sessionId, { _tag: "MemoryExclusion", seq, excluded });
      }),

    createSession: (input: {
      readonly botId: BotId;
      readonly title: string;
      readonly provider: ProviderSelection;
      readonly cwd?: string | undefined;
      readonly isolation?: "shared" | "worktree" | undefined;
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
          isolation: input.isolation,
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

    interrupt,

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
    /** Appends an Apollo-originated event (visuals, secret requests) to a session's log. */
    appendEvent: (id: SessionId, event: AgentEvent) => appendEvent(id, event).pipe(Effect.asVoid),
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
    /** What a provider's sessions can reach: claude.ai connectors, ChatGPT apps, MCP servers. */
    listConnectors,
    listModels: (provider: ProviderKind) =>
      modelLists[provider][0].pipe(Effect.mapError((error) => providerFailure(error.message))),
    /** Forgets cached model lists, after credentials or endpoints change. */
    refreshModels: Effect.forEach(Object.values(modelLists), ([, invalidate]) => invalidate, { discard: true }),

    deleteSession: (id: SessionId) =>
      Effect.gen(function* () {
        const session = yield* store.getSession(id);
        if (session.role === "main") return yield* invalid("delete the bot to remove its main session");
        yield* removeSession(id);
      }),

    reflect: requestReflection,

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
