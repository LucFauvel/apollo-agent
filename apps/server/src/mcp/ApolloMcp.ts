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
  type Schedule,
  ScheduleId,
  ScheduleKind,
  type Session,
  SessionId,
  SessionStatus,
  Skill,
} from "@apollo/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { transcriptForReflection, withoutExcluded } from "../Instructions.ts";
import * as ArtifactTools from "./ArtifactTools.ts";
import * as BrowserTools from "./BrowserTools.ts";
import * as BotTools from "./BotTools.ts";
import * as ChangeTools from "./ChangeTools.ts";
import * as JobTools from "./JobTools.ts";
import * as MonitorTools from "./MonitorTools.ts";
import * as ProjectTools from "./ProjectTools.ts";
import * as PullRequestTools from "./PullRequestTools.ts";
import * as UserTools from "./UserTools.ts";
import * as WorktreeTools from "./WorktreeTools.ts";
import { McpCaller } from "./Caller.ts";
import { AppSettings } from "../AppSettings.ts";
import { Projects } from "../projects/Projects.ts";
import { Scheduler } from "../schedule/Scheduler.ts";
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";

// ---------------------------------------------------------------------------
// Caller identity: every agent session gets its own bearer token.
// ---------------------------------------------------------------------------

export { McpCaller };

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
  description: [
    "Search the bot's long-term memory (shared across all sessions and providers) by keywords. In a session that works",
    "in a project, the project's memories are searched too; `project` (id or name) searches one project's as well.",
  ].join(" "),
  parameters: Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(Schema.Number),
    project: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ memories: Schema.Array(Memory) }),
}).annotate(Tool.Readonly, true);

const MemorySave = Tool.make("apollo_memory_save", {
  ...shared,
  description: [
    "Save a durable memory: a user preference, a fact about a project or environment, or a lesson learned. Keep it",
    "short and self-contained. Never save secrets. scope `project`: it stays in a project (yours, or the one named by",
    "`project`), and only sessions in that project find it.",
  ].join(" "),
  parameters: Schema.Struct({
    content: Schema.String,
    kind: MemoryKind,
    tags: Schema.optional(Schema.Array(Schema.String)),
    scope: Schema.optional(Schema.Literals(["bot", "global", "project"])),
    project: Schema.optional(Schema.String),
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
  description: "List the bot's skills (reusable procedures): active ones, and any waiting for the user's review.",
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

const SkillSave = Tool.make("apollo_skill_save", {
  ...shared,
  description: [
    "Save a new skill, or a better version of an existing one (same name replaces it). It is active right away",
    "(unless the user turned on skill review). `body` is markdown instructions written for a future agent: when to",
    "use it, the steps, and the pitfalls. Prefer improving an existing skill over adding a near-duplicate.",
  ].join(" "),
  parameters: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    body: Schema.String,
    scope: Schema.optional(Schema.Literals(["bot", "global"])),
  }),
  success: Skill,
}).annotate(Tool.Destructive, false);

const SkillArchive = Tool.make("apollo_skill_archive", {
  ...shared,
  description:
    "Archive a skill that is stale, wrong, or replaced by another (merged into it): it stops being offered. Archived skills are kept and the user can restore them.",
  parameters: Schema.Struct({ name: Schema.String, reason: Schema.String }),
  success: Schema.Struct({ archived: Schema.String }),
});

const ListSessions = Tool.make("apollo_list_sessions", {
  ...shared,
  description: "List this bot's sessions with their provider, status and last message.",
  success: Schema.Struct({ sessions: Schema.Array(SessionSummary) }),
}).annotate(Tool.Readonly, true);

const SpawnSession = Tool.make("apollo_spawn_session", {
  ...shared,
  description: [
    "Start a worker session for a task (orchestrator only). It runs in parallel and reports back to you when it",
    "finishes a turn. Choose the provider that fits the task. `model` must be an id from the provider's available",
    "models: check it with apollo_list_models first, never guess or reuse a name from memory (an unknown id is",
    "refused). Leave `model` out to use the default. `project` (id or name): start it in one of the bot's projects;",
    "it gets the project's context and works in the project's workspace unless `cwd` says otherwise.",
  ].join(" "),
  parameters: Schema.Struct({
    title: Schema.String,
    prompt: Schema.String,
    provider: Schema.optional(ProviderKind),
    /** An exact id from apollo_list_models for that provider; omit for the default. */
    model: Schema.optional(Schema.String),
    /** Reasoning effort, e.g. `low` for simple tasks or `high` for hard ones. */
    effort: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    /**
     * `worktree`: the worker gets its own git worktree on a new branch, so parallel workers do not
     * edit the same files. Finish it with apollo_worktree_finish (merge, keep or discard).
     */
    isolation: Schema.optional(Schema.Literals(["shared", "worktree"])),
    notifyOnCompletion: Schema.optional(Schema.Boolean),
    project: Schema.optional(Schema.String),
  }),
  success: SessionSummary,
});

const ListModels = Tool.make("apollo_list_models", {
  ...shared,
  description:
    "The models a provider offers right now, with their exact ids, which is the default, and the reasoning efforts each accepts. Use an id from here for apollo_spawn_session's `model`.",
  parameters: Schema.Struct({ provider: ProviderKind }),
  success: Schema.Struct({
    provider: ProviderKind,
    models: Schema.Array(
      Schema.Struct({ id: Schema.String, label: Schema.String, isDefault: Schema.Boolean, efforts: Schema.Array(Schema.String) }),
    ),
  }),
}).annotate(Tool.Readonly, true);

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

const ScheduleSummary = Schema.Struct({
  id: ScheduleId,
  kind: ScheduleKind,
  name: Schema.String,
  prompt: Schema.String,
  schedule: Schema.String,
  enabled: Schema.Boolean,
  createdBy: Schema.String,
  nextRunAt: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  lastStatus: Schema.NullOr(Schema.String),
});

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

const summarizeSchedule = (s: Schedule) => ({
  id: s.id,
  kind: s.kind,
  name: s.name,
  prompt: s.prompt,
  schedule: `${s.description} (${s.timezone})`,
  enabled: s.enabled,
  createdBy: s.createdBy,
  nextRunAt: iso(s.nextRunAt),
  lastRunAt: iso(s.lastRunAt),
  lastStatus: s.lastStatus,
});

const ScheduleList = Tool.make("apollo_schedule_list", {
  ...shared,
  description: "List this bot's scheduled tasks and heartbeats (orchestrator only).",
  success: Schema.Struct({ schedules: Schema.Array(ScheduleSummary) }),
}).annotate(Tool.Readonly, true);

const ScheduleCreate = Tool.make("apollo_schedule_create", {
  ...shared,
  description: [
    "Schedule work for later or on a recurring basis (orchestrator only; only for what the user asked for or agreed to).",
    "kind `task`: `prompt` runs in a fresh worker session that does not see this conversation, so make it self-contained;",
    "its result comes back to you and the user is notified. kind `heartbeat`: `prompt` is sent into this conversation.",
    '`schedule`: "every 2h", "daily at 9am", "weekdays at 8:30", "every monday 9am", "in 30m", "tomorrow at 9am",',
    '"2026-12-01 09:00" or a 5-field cron expression. Recurring schedules run at most every 5 minutes.',
  ].join(" "),
  parameters: Schema.Struct({
    kind: ScheduleKind,
    name: Schema.String,
    prompt: Schema.String,
    schedule: Schema.String,
    /** IANA time zone; defaults to this machine's. */
    timezone: Schema.optional(Schema.String),
    /** Task runs only: provider, model and effort (defaults to the bot's worker settings). */
    provider: Schema.optional(ProviderKind),
    model: Schema.optional(Schema.String),
    effort: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
  }),
  success: ScheduleSummary,
});

const ScheduleUpdate = Tool.make("apollo_schedule_update", {
  ...shared,
  description: "Change, pause (`enabled: false`) or resume one of this bot's schedules (orchestrator only).",
  parameters: Schema.Struct({
    id: ScheduleId,
    name: Schema.optional(Schema.String),
    prompt: Schema.optional(Schema.String),
    schedule: Schema.optional(Schema.String),
    timezone: Schema.optional(Schema.String),
    enabled: Schema.optional(Schema.Boolean),
  }),
  success: ScheduleSummary,
});

const ScheduleDelete = Tool.make("apollo_schedule_delete", {
  ...shared,
  description: "Delete one of this bot's schedules (orchestrator only).",
  parameters: Schema.Struct({ id: ScheduleId }),
  success: Schema.Struct({}),
});

const Notify = Tool.make("apollo_notify", {
  ...shared,
  description: [
    "Send the user a desktop notification; clicking it opens this session.",
    "Use it for things they asked to hear about or must act on now (a long job finished, a decision is needed),",
    "not for routine progress. Keep `title` to a few words and `body` to a sentence or two.",
  ].join(" "),
  parameters: Schema.Struct({ title: Schema.String, body: Schema.String }),
  success: Schema.Struct({ sent: Schema.Boolean }),
}).annotate(Tool.Destructive, false);

export const ApolloToolkit = Toolkit.make(
  Notify,
  MemorySearch,
  MemorySave,
  MemoryForget,
  CoreMemoryEdit,
  SessionSearch,
  SessionRead,
  SkillList,
  SkillRead,
  SkillSave,
  SkillArchive,
  ListSessions,
  SpawnSession,
  ListModels,
  SendToSession,
  WaitSession,
  InterruptSession,
  ScheduleList,
  ScheduleCreate,
  ScheduleUpdate,
  ScheduleDelete,
);

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

/** Why a requested model id cannot be used, or null when the provider offers it. */
export const unknownModel = (model: string, provider: string, available: ReadonlyArray<{ readonly id: string }>) =>
  available.some((m) => m.id === model)
    ? null
    : `"${model}" is not a ${provider} model. Available: ${available.map((m) => m.id).join(", ") || "none"}. Use one of these ids, or omit model for the default.`;

const handlers = ApolloToolkit.toLayer(
  Effect.gen(function* () {
    const appSettings = yield* AppSettings;
    const store = yield* Store;
    const manager = yield* SessionManager;
    const scheduler = yield* Scheduler;
    const projects = yield* Projects;

    /**
     * The project a memory call is about: the one named, else the caller's own (or none). A
     * session in a project reaches only its own project.
     */
    const memoryProject = (ref: string | undefined) =>
      Effect.gen(function* () {
        const caller = yield* McpCaller;
        const own = (yield* store.getSession(caller.sessionId)).projectId ?? null;
        if (!ref?.trim()) return own;
        const project = yield* projects.resolve(caller.botId, ref);
        if (own && project.id !== own) return yield* invalid("a session in a project can only reach its own project");
        return project.id;
      });

    /**
     * Schedules belong to the orchestrator, and never to a turn a schedule started:
     * a scheduled run that schedules more runs could multiply without anyone asking.
     */
    const scheduleCaller = Effect.gen(function* () {
      const caller = yield* McpCaller;
      if (caller.role !== "main") return yield* invalid("only the bot's orchestrator session can manage schedules");
      if (yield* scheduler.isScheduledTurn(caller.sessionId)) {
        return yield* invalid("schedules cannot be changed from a scheduled run or heartbeat; ask the user");
      }
      return caller;
    });

    const ownSchedule = (botId: BotId, id: ScheduleId) =>
      Effect.gen(function* () {
        const schedule = yield* scheduler.get(id);
        if (schedule.botId !== botId) return yield* invalid("that schedule belongs to another bot");
        return schedule;
      });

    /** A session the caller may control: same bot, and not the caller itself. */
    const ownSession = (callerBot: BotId, id: SessionId) =>
      Effect.gen(function* () {
        const session = yield* store.getSession(id);
        if (session.botId !== callerBot) return yield* invalid("that session belongs to another bot");
        if (session.role === "main") return yield* invalid("cannot control the orchestrator session");
        return session;
      });

    return {
      apollo_notify: ({ title, body }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          if (!title.trim() && !body.trim()) return yield* invalid("title and body are empty");
          yield* manager.publish({
            _tag: "Notify",
            botId: caller.botId,
            sessionId: caller.sessionId,
            title: title.trim().slice(0, 120),
            body: body.trim().slice(0, 400),
          });
          return { sent: true };
        }),

      apollo_memory_search: ({ query, limit, project }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const memories = yield* store.searchMemories(
            caller.botId,
            query,
            Math.min(Math.max(limit ?? 8, 1), 25),
            yield* memoryProject(project),
          );
          return { memories };
        }),

      apollo_memory_save: ({ content, kind, tags, scope, project }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          if (content.trim().length === 0) return yield* invalid("content is empty");
          if (project?.trim() && scope !== "project") return yield* invalid("`project` goes with scope `project`");
          const projectId = scope === "project" ? yield* memoryProject(project) : null;
          if (scope === "project" && !projectId) {
            return yield* invalid("scope `project` needs a project: name it (`project`), or save from a session in one");
          }
          const botId = scope === "global" ? null : caller.botId;
          const memory = yield* store.insertMemory({
            botId,
            kind,
            content: content.trim(),
            tags: tags ?? [],
            sourceSessionId: caller.sessionId,
            projectId,
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
            // Identical entries are one entry: any of them will do.
            const distinct = new Set(hits.map((i) => current[i]!.toLowerCase()));
            if (distinct.size > 1) return Effect.fail(invalid(`"${match}" matches ${hits.length} entries; be more specific`));
            return Effect.succeed(hits[0]!);
          };
          const needText = () =>
            text && text.trim() ? Effect.succeed(text.trim()) : Effect.fail(invalid("`text` is required"));

          let next: ReadonlyArray<string> = current;
          switch (action) {
            case "view":
              break;
            case "add": {
              const value = yield* needText();
              // Already there: nothing to add (a second copy would only use up the budget).
              next = current.some((entry) => entry.toLowerCase() === value.toLowerCase()) ? current : [...current, value];
              break;
            }
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
          const events = withoutExcluded(
            yield* store.eventsAround(sessionId, seq, Math.min(Math.max(radius ?? 10, 1), 50)),
            yield* store.memoryExclusions(sessionId),
          );
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

      apollo_skill_save: ({ name, description, body, scope }) =>
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
          // Active right away, replacing the previous version, unless the user reviews skills.
          const review = (yield* appSettings.read).reviewSkills;
          const saved = yield* store.insertSkill({
            botId,
            name: slug,
            description: description.trim(),
            body: body.trim(),
            status: "proposed",
            sourceSessionId: caller.sessionId,
          });
          if (!review) yield* store.setSkillStatus(saved.id, "active");
          yield* manager.publishSkillChanged(botId);
          return review ? saved : { ...saved, status: "active" as const };
        }),

      apollo_skill_archive: ({ name, reason }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const skill = yield* store.findActiveSkill(caller.botId, name.trim().toLowerCase());
          if (!skill) return yield* invalid(`no active skill "${name}"`);
          yield* store.setSkillStatus(skill.id, "archived");
          yield* manager.publishSkillChanged(skill.botId);
          yield* Effect.logInfo(`skill ${skill.name} archived: ${reason}`);
          return { archived: skill.name };
        }),

      apollo_list_sessions: () =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const sessions = yield* store.listSessions(caller.botId);
          return { sessions: sessions.filter((s) => s.role !== "reflection").map(summarize) };
        }),

      apollo_list_models: ({ provider }) =>
        Effect.gen(function* () {
          const models = yield* manager.listModels(provider).pipe(
            Effect.mapError((e) => new ApolloError({ code: "internal", message: `could not list ${provider} models: ${"message" in e ? e.message : String(e)}` })),
          );
          return { provider, models: models.map((m) => ({ id: m.id, label: m.label, isDefault: m.isDefault, efforts: m.efforts })) };
        }),

      apollo_spawn_session: ({ title, prompt, provider, model, effort, cwd, isolation, notifyOnCompletion, project }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          if (caller.role !== "main") {
            return yield* invalid("only the bot's orchestrator session can spawn workers");
          }
          const bot = yield* store.getBot(caller.botId);
          if (bot.pausedReason !== null) {
            return yield* invalid(`${bot.name} is paused (${bot.pausedReason}). Only the user can resume it.`);
          }
          const projectId = project?.trim() ? (yield* projects.resolve(bot.id, project)).id : null;
          yield* manager.guardWorkerCapacity(bot.id);
          // A different provider starts from its own defaults; the same one inherits the bot's.
          const base = provider && provider !== bot.defaultWorker.provider ? { provider } : bot.defaultWorker;
          // Only ids the provider offers: a guessed one would fail later, inside the worker.
          if (model) {
            const available = yield* manager.listModels(base.provider).pipe(Effect.orElseSucceed(() => null));
            const problem = available ? unknownModel(model, base.provider, available) : null;
            if (problem) return yield* invalid(problem);
          }
          const selection = { ...base, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
          const session = yield* manager.createSession({
            botId: bot.id,
            title,
            provider: selection,
            cwd,
            isolation,
            prompt,
            parentSessionId: caller.sessionId,
            notifyParent: notifyOnCompletion ?? true,
            author: "bot",
            projectId,
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

      apollo_schedule_list: () =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          if (caller.role !== "main") return yield* invalid("only the bot's orchestrator session can manage schedules");
          return { schedules: (yield* scheduler.list(caller.botId)).map(summarizeSchedule) };
        }),

      apollo_schedule_create: ({ kind, name, prompt, schedule, timezone, provider, model, effort, cwd }) =>
        Effect.gen(function* () {
          const caller = yield* scheduleCaller;
          const bot = yield* store.getBot(caller.botId);
          const base = provider && provider !== bot.defaultWorker.provider ? { provider } : null;
          const selection =
            base || model || effort
              ? { ...(base ?? bot.defaultWorker), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
              : null;
          const created = yield* scheduler.create(
            { botId: caller.botId, kind, name, prompt, spec: schedule, timezone, provider: selection, cwd },
            "bot",
          );
          return summarizeSchedule(created);
        }),

      apollo_schedule_update: ({ id, name, prompt, schedule, timezone, enabled }) =>
        Effect.gen(function* () {
          const caller = yield* scheduleCaller;
          yield* ownSchedule(caller.botId, id);
          const updated = yield* scheduler.update({ scheduleId: id, name, prompt, spec: schedule, timezone, enabled });
          return summarizeSchedule(updated);
        }),

      apollo_schedule_delete: ({ id }) =>
        Effect.gen(function* () {
          const caller = yield* scheduleCaller;
          yield* ownSchedule(caller.botId, id);
          yield* scheduler.remove(id);
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
  registrations: Layer.mergeAll(
    McpServer.toolkit(ApolloToolkit).pipe(Layer.provide(handlers)),
    McpServer.toolkit(BrowserTools.BrowserToolkit).pipe(Layer.provide(BrowserTools.handlers)),
    McpServer.toolkit(UserTools.UserToolkit).pipe(Layer.provide(UserTools.handlers)),
    McpServer.toolkit(JobTools.JobToolkit).pipe(Layer.provide(JobTools.handlers)),
    McpServer.toolkit(MonitorTools.MonitorToolkit).pipe(Layer.provide(MonitorTools.handlers)),
    McpServer.toolkit(WorktreeTools.WorktreeToolkit).pipe(Layer.provide(WorktreeTools.handlers)),
    McpServer.toolkit(ChangeTools.ChangeToolkit).pipe(Layer.provide(ChangeTools.handlers)),
    McpServer.toolkit(BotTools.BotToolkit).pipe(Layer.provide(BotTools.handlers)),
    McpServer.toolkit(PullRequestTools.PullRequestToolkit).pipe(Layer.provide(PullRequestTools.handlers)),
    McpServer.toolkit(ProjectTools.ProjectToolkit).pipe(Layer.provide(ProjectTools.handlers)),
    McpServer.toolkit(ArtifactTools.ArtifactToolkit).pipe(Layer.provide(ArtifactTools.handlers)),
  ),
}).pipe(Layer.provide(authMiddleware));
