import { ApolloError, Memory, PROJECT_CONTEXT_LIMIT, type Project, ProjectStatus, SessionId, SessionStatus } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { Projects } from "../projects/Projects.ts";
import { Store } from "../Store.ts";
import { McpCaller } from "./Caller.ts";

/** Projects: long-standing work under a bot, with its own context and memories. */

const shared = {
  failure: ApolloError,
  failureMode: "return" as const,
  dependencies: [McpCaller],
};

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

const ProjectSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  summary: Schema.String,
  status: ProjectStatus,
  cwd: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});

const summarize = (p: Project) => ({
  id: p.id,
  name: p.name,
  summary: p.summary,
  status: p.status,
  cwd: p.cwd,
  updatedAt: new Date(p.updatedAt).toISOString(),
});

/** The project's id or name; omitted in a session that works in a project, that project. */
const ProjectRef = Schema.optional(Schema.String);

const ProjectList = Tool.make("apollo_project_list", {
  ...shared,
  description: "List the bot's projects (long-standing work with its own context and memories): name, summary, status.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ projects: Schema.Array(ProjectSummary) }),
}).annotate(Tool.Readonly, true);

const ProjectRead = Tool.make("apollo_project_read", {
  ...shared,
  description:
    "Load a project's full context, its most recently used memories and its sessions. Use it before working on a project or delegating to it. `project`: its id or name (omit it for your own project).",
  parameters: Schema.Struct({ project: ProjectRef }),
  success: Schema.Struct({
    project: ProjectSummary,
    context: Schema.String,
    memories: Schema.Array(Memory),
    sessions: Schema.Array(
      Schema.Struct({ id: SessionId, title: Schema.String, status: SessionStatus, lastMessage: Schema.NullOr(Schema.String) }),
    ),
  }),
}).annotate(Tool.Readonly, true);

const ProjectCreate = Tool.make("apollo_project_create", {
  ...shared,
  description: [
    "Start a project (orchestrator only): long-standing work whose context and memories stay in it, instead of in the",
    "bot's memory. `summary` is one line (what it is, where it stands): it is all the orchestrator's prompt shows.",
    "`context` is markdown with the details: goals, decisions, status, where things are. `cwd`: the workspace of",
    "sessions started in it (default: the bot's).",
  ].join(" "),
  parameters: Schema.Struct({
    name: Schema.String,
    summary: Schema.String,
    context: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
  }),
  success: ProjectSummary,
}).annotate(Tool.Destructive, false);

const ProjectUpdate = Tool.make("apollo_project_update", {
  ...shared,
  description: [
    "Update a project. `append` adds a note to the end of its context; `context` replaces the whole context (condense",
    `it: at most ${PROJECT_CONTEXT_LIMIT} characters). \`summary\` is its one line for the orchestrator; \`status\``,
    "`archived` when it is done. `project`: its id or name (omit it for your own project). A session in a project can",
    "update only that project; the orchestrator, any of the bot's.",
  ].join(" "),
  parameters: Schema.Struct({
    project: ProjectRef,
    name: Schema.optional(Schema.String),
    summary: Schema.optional(Schema.String),
    context: Schema.optional(Schema.String),
    append: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    status: Schema.optional(ProjectStatus),
  }),
  success: ProjectSummary,
});

export const ProjectToolkit = Toolkit.make(ProjectList, ProjectRead, ProjectCreate, ProjectUpdate);

export const handlers = ProjectToolkit.toLayer(
  Effect.gen(function* () {
    const projects = yield* Projects;
    const store = yield* Store;

    /**
     * The project a call is about: the one named, or the caller's own. A session in a project
     * reaches only that project; the orchestrator (and sessions outside projects) any of the bot's.
     */
    const target = (ref: string | undefined) =>
      Effect.gen(function* () {
        const caller = yield* McpCaller;
        const session = yield* store.getSession(caller.sessionId);
        const own = session.projectId ?? null;
        if (!ref?.trim()) {
          if (!own) return yield* invalid("name the project (`project`): this session is not in one");
          return yield* store.getProject(own);
        }
        const project = yield* projects.resolve(caller.botId, ref);
        if (own && project.id !== own) return yield* invalid("a session in a project can only reach its own project");
        return project;
      });

    return {
      apollo_project_list: () =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          return { projects: (yield* projects.list(caller.botId)).map(summarize) };
        }),

      apollo_project_read: ({ project: ref }) =>
        Effect.gen(function* () {
          const project = yield* target(ref);
          const memories = yield* store.projectMemories(project.id, 30);
          const sessions = (yield* store.listSessions(project.botId)).filter(
            (s) => s.projectId === project.id && s.role !== "reflection",
          );
          return {
            project: summarize(project),
            context: project.context || "(empty)",
            memories,
            sessions: sessions.map((s) => ({ id: s.id, title: s.title, status: s.status, lastMessage: s.lastMessage })),
          };
        }),

      apollo_project_create: ({ name, summary, context, cwd }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          if (caller.role !== "main") return yield* invalid("only the bot's orchestrator session can start projects");
          return summarize(yield* projects.create({ botId: caller.botId, name, summary, context, cwd }));
        }),

      apollo_project_update: ({ project: ref, name, summary, context, append, cwd, status }) =>
        Effect.gen(function* () {
          const project = yield* target(ref);
          if (context !== undefined && append !== undefined) return yield* invalid("give `context` or `append`, not both");
          const nextContext =
            append !== undefined && append.trim()
              ? `${project.context.trimEnd()}${project.context.trim() ? "\n\n" : ""}${append.trim()}`
              : context;
          const updated = yield* projects.update({ projectId: project.id, name, summary, context: nextContext, cwd, status });
          return summarize(updated);
        }),
    };
  }),
);
