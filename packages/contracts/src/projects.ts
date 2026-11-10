import * as Schema from "effect/Schema";
import { BotId, ProjectId, Timestamp } from "./domain.ts";

export const ProjectStatus = Schema.Literals(["active", "archived"]);
export type ProjectStatus = typeof ProjectStatus.Type;

/** Longest one-line summary: it goes into the orchestrator's prompt for every project. */
export const PROJECT_SUMMARY_LIMIT = 300;
/** Longest project context: it goes into the prompt of every session in the project. */
export const PROJECT_CONTEXT_LIMIT = 20_000;

/**
 * Long-standing work under a bot. The bot's orchestrator knows each project by its name and
 * summary; the details (`context`, and memories saved to the project) stay in the project and
 * reach only the sessions started in it, or an agent that reads the project.
 */
export const Project = Schema.Struct({
  id: ProjectId,
  botId: BotId,
  name: Schema.String,
  /** One line on what it is and where it stands. */
  summary: Schema.String,
  /** Markdown: goals, decisions, status, where things are. */
  context: Schema.String,
  /** Workspace of sessions started in it; `null` uses the bot's. */
  cwd: Schema.NullOr(Schema.String),
  status: ProjectStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Project = typeof Project.Type;

/**
 * `projects.watch`: every project, then each change. Its own stream, not an AppChange, so
 * clients built before projects keep syncing (see AppChange).
 */
export const ProjectsChange = Schema.Union([
  Schema.TaggedStruct("ProjectsSnapshot", { projects: Schema.Array(Project) }),
  Schema.TaggedStruct("ProjectUpserted", { project: Project }),
  Schema.TaggedStruct("ProjectDeleted", { projectId: ProjectId, botId: BotId }),
]);
export type ProjectsChange = typeof ProjectsChange.Type;

export const CreateProjectInput = Schema.Struct({
  botId: BotId,
  name: Schema.String,
  summary: Schema.String,
  context: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CreateProjectInput = typeof CreateProjectInput.Type;

/** Omitted fields stay as they are. */
export const UpdateProjectInput = Schema.Struct({
  projectId: ProjectId,
  name: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(ProjectStatus),
});
export type UpdateProjectInput = typeof UpdateProjectInput.Type;
