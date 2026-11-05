import {
  ApolloError,
  type BotId,
  CORE_MEMORY_LIMITS,
  CoreMemoryTarget,
  coreMemoryUsage,
  Memory,
  MemoryId,
  MemoryKind,
  ProviderKind,
  type Session,
  SessionId,
  SessionStatus,
  type SessionRole,
  Skill,
} from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { transcriptForReflection } from "../Instructions.ts";
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";

// ---------------------------------------------------------------------------
// Caller identity: every agent session gets its own bearer token.
// ---------------------------------------------------------------------------

export class McpCaller extends Context.Service<
  McpCaller,
  { readonly sessionId: SessionId; readonly botId: BotId; readonly role: SessionRole }
>()("apollo/McpCaller") {}

const authMiddleware = HttpRouter.middleware<{ provides: McpCaller }>()(
  Effect.gen(function* () {
    const manager = yield* SessionManager;
    const store = yield* Store;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const header = request.headers.authorization ?? "";
        const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
        const sessionId = token ? yield* manager.resolveToken(token) : undefined;
        const session = sessionId ? yield* Effect.option(store.getSession(sessionId)) : undefined;
        if (!session || session._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "unknown or expired Apollo session token" },
            { status: 401 },
          );
        }
        return yield* Effect.provideService(httpEffect, McpCaller, {
          sessionId: session.value.id,
          botId: session.value.botId,
          role: session.value.role,
        });
      });
  }),
).layer;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const SessionSummary = Schema.Struct({
  id: SessionId,
  title: Schema.String,
  role: Schema.String,
  provider: ProviderKind,
  status: SessionStatus,
  lastMessage: Schema.NullOr(Schema.String),
});

const summarize = (s: Session) => ({
  id: s.id,
  title: s.title,
  role: s.role,
  provider: s.provider,
  status: s.status,
  lastMessage: s.lastMessage,
});

const shared = {
  failure: ApolloError,
  failureMode: "return" as const,
  dependencies: [McpCaller],
};

const MemorySearch = Tool.make("apollo_memory_search", {
  ...shared,
  description:
    "Search the bot's long-term memory (shared across all sessions and providers) by keywords.",
  parameters: Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(Schema.Number),
  }),
  success: Schema.Struct({ memories: Schema.Array(Memory) }),
}).annotate(Tool.Readonly, true);

const MemorySave = Tool.make("apollo_memory_save", {
  ...shared,
  description:
    "Save a durable memory: a user preference, a fact about a project or environment, or a lesson learned. Keep it short and self-contained. Never save secrets.",
  parameters: Schema.Struct({
    content: Schema.String,
    kind: MemoryKind,
    tags: Schema.optional(Schema.Array(Schema.String)),
    scope: Schema.optional(Schema.Literals(["bot", "global"])),
  }),
  success: Memory,
}).annotate(Tool.Destructive, false);

const MemoryForget = Tool.make("apollo_memory_forget", {
  ...shared,
  description:
    "Delete archive memories that are wrong, outdated or duplicated (ids come from apollo_memory_search). To correct one, forget it and save the corrected version.",
  parameters: Schema.Struct({ ids: Schema.Array(MemoryId) }),
  success: Schema.Struct({ forgotten: Schema.Number }),
});

const CoreMemoryEntries = Schema.Struct({
  target: CoreMemoryTarget,
  entries: Schema.Array(Schema.String),
  used: Schema.Number,
  limit: Schema.Number,
});

const CoreMemoryEdit = Tool.make("apollo_core_memory", {
  ...shared,
  description: [
    "Edit core memory, the small notes included in every future session's prompt.",
    "target `user`: about the user, shared by all bots. target `notes`: this bot's own notes.",
    "action `add` appends `text`; `replace` swaps the entry containing `match` for `text`; `remove` deletes the entry containing `match`;",
    "`view` returns the current entries. Each target has a character budget: when an edit does not fit, consolidate",
    "(merge or shorten entries) and keep details in the archive with apollo_memory_save.",
  ].join(" "),
  parameters: Schema.Struct({
    target: CoreMemoryTarget,
    action: Schema.Literals(["view", "add", "replace", "remove"]),
    text: Schema.optional(Schema.String),
    match: Schema.optional(Schema.String),
  }),
  success: CoreMemoryEntries,
});

const TranscriptHit = Schema.Struct({
  sessionId: SessionId,
  sessionTitle: Schema.String,
  provider: ProviderKind,
  seq: Schema.Number,
  at: Schema.String,
  excerpt: Schema.String,
});

const SessionSearch = Tool.make("apollo_session_search", {
  ...shared,
  description:
    "Search this bot's past conversations (all sessions and providers) by keywords. Use it to recall earlier decisions, fixes and discussions. Read around a hit with apollo_session_read.",
  parameters: Schema.Struct({ query: Schema.String, limit: Schema.optional(Schema.Number) }),
  success: Schema.Struct({ hits: Schema.Array(TranscriptHit) }),
}).annotate(Tool.Readonly, true);

const SessionRead = Tool.make("apollo_session_read", {
  ...shared,
  description: "Read the messages of one of this bot's sessions around a position (`seq` from apollo_session_search).",
  parameters: Schema.Struct({
    sessionId: SessionId,
    seq: Schema.Number,
    radius: Schema.optional(Schema.Number),
  }),
  success: Schema.Struct({ transcript: Schema.String }),
}).annotate(Tool.Readonly, true);

const SkillList = Tool.make("apollo_skill_list", {
  ...shared,
  description: "List the bot's skills (reusable procedures), including pending proposals.",
  success: Schema.Struct({
    skills: Schema.Array(
      Schema.Struct({ name: Schema.String, description: Schema.String, status: Schema.String }),
    ),
  }),
}).annotate(Tool.Readonly, true);

const SkillRead = Tool.make("apollo_skill_read", {
  ...shared,
  description: "Load the full instructions of an active skill by name.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Skill,
}).annotate(Tool.Readonly, true);

const SkillPropose = Tool.make("apollo_skill_propose", {
  ...shared,
  description:
    "Propose a new skill, or an improved version of an existing one (same name). The user reviews proposals before they become active. `body` is markdown instructions written for a future agent.",
  parameters: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    body: Schema.String,
    scope: Schema.optional(Schema.Literals(["bot", "global"])),
  }),
  success: Skill,
}).annotate(Tool.Destructive, false);

const ListSessions = Tool.make("apollo_list_sessions", {
  ...shared,
  description: "List this bot's sessions with their provider, status and last message.",
  success: Schema.Struct({ sessions: Schema.Array(SessionSummary) }),
}).annotate(Tool.Readonly, true);

const SpawnSession = Tool.make("apollo_spawn_session", {
  ...shared,
  description:
    "Start a worker session for a task (orchestrator only). It runs in parallel and reports back to you when it finishes a turn. Choose the provider that fits the task.",
  parameters: Schema.Struct({
    title: Schema.String,
    prompt: Schema.String,
    provider: Schema.optional(ProviderKind),
    model: Schema.optional(Schema.String),
    /** Reasoning effort, e.g. `low` for simple tasks or `high` for hard ones. */
    effort: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    notifyOnCompletion: Schema.optional(Schema.Boolean),
  }),
  success: SessionSummary,
});

const SendToSession = Tool.make("apollo_send_to_session", {
  ...shared,
  description: "Send a follow-up message to one of this bot's worker sessions.",
  parameters: Schema.Struct({ sessionId: SessionId, message: Schema.String }),
  success: SessionSummary,
});

const WaitSession = Tool.make("apollo_wait_session", {
  ...shared,
  description:
    "Wait until a worker session finishes its current turn (or the timeout passes), then return its status and last message.",
  parameters: Schema.Struct({
    sessionId: SessionId,
    timeoutSeconds: Schema.optional(Schema.Number),
  }),
  success: Schema.Struct({ session: SessionSummary, timedOut: Schema.Boolean }),
}).annotate(Tool.Readonly, true);

const InterruptSession = Tool.make("apollo_interrupt_session", {
  ...shared,
  description: "Interrupt a worker session's running turn.",
  parameters: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Struct({}),
});

export const ApolloToolkit = Toolkit.make(
  MemorySearch,
  MemorySave,
  MemoryForget,
  CoreMemoryEdit,
  SessionSearch,
  SessionRead,
  SkillList,
  SkillRead,
  SkillPropose,
  ListSessions,
  SpawnSession,
  SendToSession,
  WaitSession,
  InterruptSession,
);

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

const handlers = ApolloToolkit.toLayer(
  Effect.gen(function* () {
    const store = yield* Store;
    const manager = yield* SessionManager;

    /** A session the caller may control: same bot, and not the caller itself. */
    const ownSession = (callerBot: BotId, id: SessionId) =>
      Effect.gen(function* () {
        const session = yield* store.getSession(id);
        if (session.botId !== callerBot) return yield* invalid("that session belongs to another bot");
        if (session.role === "main") return yield* invalid("cannot control the orchestrator session");
        return session;
      });

    return {
      apollo_memory_search: ({ query, limit }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const memories = yield* store.searchMemories(
            caller.botId,
            query,
            Math.min(Math.max(limit ?? 8, 1), 25),
          );
          return { memories };
        }),

      apollo_memory_save: ({ content, kind, tags, scope }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          if (content.trim().length === 0) return yield* invalid("content is empty");
          const botId = scope === "global" ? null : caller.botId;
          const memory = yield* store.insertMemory({
            botId,
            kind,
            content: content.trim(),
            tags: tags ?? [],
            sourceSessionId: caller.sessionId,
          });
          yield* manager.publishMemoryChanged(botId);
          return memory;
        }),

      apollo_memory_forget: ({ ids }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          let forgotten = 0;
          const scopes = new Set<BotId | null>();
          for (const id of ids) {
            const memory = yield* Effect.option(store.getMemory(id));
            if (memory._tag === "None") continue;
            if (memory.value.botId !== null && memory.value.botId !== caller.botId) {
              return yield* invalid(`memory ${id} belongs to another bot`);
            }
            yield* store.deleteMemory(id);
            scopes.add(memory.value.botId);
            forgotten++;
          }
          for (const scope of scopes) yield* manager.publishMemoryChanged(scope);
          return { forgotten };
        }),

      apollo_core_memory: ({ target, action, text, match }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const current = (yield* store.getCoreMemory(caller.botId))[target];
          const find = () => {
            const needle = (match ?? "").trim().toLowerCase();
            if (!needle) return Effect.fail(invalid("`match` is required: a distinctive part of the entry"));
            const hits = current.flatMap((entry, index) => (entry.toLowerCase().includes(needle) ? [index] : []));
            if (hits.length === 0) return Effect.fail(invalid(`no ${target} entry contains "${match}"`));
            if (hits.length > 1) return Effect.fail(invalid(`"${match}" matches ${hits.length} entries; be more specific`));
            return Effect.succeed(hits[0]!);
          };
          const needText = () =>
            text && text.trim() ? Effect.succeed(text.trim()) : Effect.fail(invalid("`text` is required"));

          let next: ReadonlyArray<string> = current;
          switch (action) {
            case "view":
              break;
            case "add":
              next = [...current, yield* needText()];
              break;
            case "replace": {
              const index = yield* find();
              const value = yield* needText();
              next = current.map((entry, i) => (i === index ? value : entry));
              break;
            }
            case "remove": {
              const index = yield* find();
              next = current.filter((_, i) => i !== index);
              break;
            }
          }
          if (action !== "view") {
            next = yield* store.setCoreMemory(caller.botId, target, next);
            yield* manager.publishMemoryChanged(target === "user" ? null : caller.botId);
          }
          return { target, entries: next, used: coreMemoryUsage(next), limit: CORE_MEMORY_LIMITS[target] };
        }),

      apollo_session_search: ({ query, limit }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const hits = yield* store.searchTranscripts(
            caller.botId,
            query,
            Math.min(Math.max(limit ?? 8, 1), 25),
            caller.sessionId,
          );
          return { hits: hits.map((h) => ({ ...h, at: new Date(h.at).toISOString() })) };
        }),

      apollo_session_read: ({ sessionId, seq, radius }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const session = yield* store.getSession(sessionId);
          if (session.botId !== caller.botId) return yield* invalid("that session belongs to another bot");
          const events = yield* store.eventsAround(sessionId, seq, Math.min(Math.max(radius ?? 10, 1), 50));
          return { transcript: transcriptForReflection(events, 20_000) || "(nothing to show in that range)" };
        }),

      apollo_skill_list: () =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const skills = yield* store.listSkills(caller.botId);
          return {
            skills: skills
              .filter((s) => s.status !== "archived")
              .map((s) => ({ name: s.name, description: s.description, status: s.status })),
          };
        }),

      apollo_skill_read: ({ name }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const skill = yield* store.findActiveSkill(caller.botId, name);
          return skill ?? (yield* new ApolloError({ code: "not_found", message: `no active skill "${name}"` }));
        }),

      apollo_skill_propose: ({ name, description, body, scope }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const slug = name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
          if (slug.length === 0 || body.trim().length === 0) {
            return yield* invalid("name and body are required");
          }
          const botId = scope === "global" ? null : caller.botId;
          const skill = yield* store.insertSkill({
            botId,
            name: slug,
            description: description.trim(),
            body: body.trim(),
            status: "proposed",
            sourceSessionId: caller.sessionId,
          });
          yield* manager.publishSkillChanged(botId);
          return skill;
        }),

      apollo_list_sessions: () =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const sessions = yield* store.listSessions(caller.botId);
          return { sessions: sessions.filter((s) => s.role !== "reflection").map(summarize) };
        }),

      apollo_spawn_session: ({ title, prompt, provider, model, effort, cwd, notifyOnCompletion }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          if (caller.role !== "main") {
            return yield* invalid("only the bot's orchestrator session can spawn workers");
          }
          const bot = yield* store.getBot(caller.botId);
          if (bot.pausedReason !== null) {
            return yield* invalid(`${bot.name} is paused (${bot.pausedReason}). Only the user can resume it.`);
          }
          yield* manager.guardWorkerCapacity(bot.id);
          // A different provider starts from its own defaults; the same one inherits the bot's.
          const base = provider && provider !== bot.defaultWorker.provider ? { provider } : bot.defaultWorker;
          const selection = { ...base, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
          const session = yield* manager.createSession({
            botId: bot.id,
            title,
            provider: selection,
            cwd,
            prompt,
            parentSessionId: caller.sessionId,
            notifyParent: notifyOnCompletion ?? true,
            author: "bot",
          });
          return summarize(yield* store.getSession(session.id));
        }),

      apollo_send_to_session: ({ sessionId, message }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const target = yield* ownSession(caller.botId, sessionId);
          // Steering a running worker adds no concurrency; waking an idle one does.
          if (target.status === "idle" || target.status === "error") yield* manager.guardWorkerCapacity(caller.botId);
          yield* manager.send(sessionId, message, "bot");
          return summarize(yield* store.getSession(sessionId));
        }),

      apollo_wait_session: ({ sessionId, timeoutSeconds }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          yield* ownSession(caller.botId, sessionId);
          const seconds = Math.min(Math.max(timeoutSeconds ?? 120, 1), 600);
          const { session, timedOut } = yield* manager.waitUntilIdle(sessionId, Duration.seconds(seconds));
          return { session: summarize(session), timedOut };
        }),

      apollo_interrupt_session: ({ sessionId }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          yield* ownSession(caller.botId, sessionId);
          yield* manager.interrupt(sessionId);
          return {};
        }),
    };
  }),
);

/** Streamable-HTTP MCP endpoint at `/mcp`, authenticated per agent session. */
export const layer = McpServer.layerHttp({
  name: "Apollo",
  version: "0.0.0",
  path: "/mcp",
  protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
  allowSessionTermination: true,
  registrations: McpServer.toolkit(ApolloToolkit).pipe(Layer.provide(handlers)),
}).pipe(Layer.provide(authMiddleware));
