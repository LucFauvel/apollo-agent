import { mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  ApolloError,
  type BotId,
  type CreateProjectInput,
  type Project,
  PROJECT_CONTEXT_LIMIT,
  PROJECT_SUMMARY_LIMIT,
  type ProjectId,
  type ProjectsChange,
  type UpdateProjectInput,
} from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { AppSettings } from "../AppSettings.ts";
import { SessionManager } from "../SessionManager.ts";
import { newId, Store } from "../Store.ts";

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Why a project's fields cannot be saved, or null. */
export const projectProblem = (
  fields: { readonly name: string; readonly summary: string; readonly context: string },
  others: ReadonlyArray<Pick<Project, "name">>,
): string | null => {
  if (!fields.name) return "a project needs a name";
  if (fields.name.length > 80) return "keep the project name under 80 characters";
  if (others.some((p) => p.name.toLowerCase() === fields.name.toLowerCase())) {
    return `the bot already has a project named "${fields.name}"`;
  }
  if (fields.summary.length > PROJECT_SUMMARY_LIMIT) {
    return `the summary is ${fields.summary.length} characters; keep it under ${PROJECT_SUMMARY_LIMIT} (details go in the context)`;
  }
  if (fields.context.length > PROJECT_CONTEXT_LIMIT) {
    return `the context is ${fields.context.length} characters, over the ${PROJECT_CONTEXT_LIMIT} limit: condense it, and keep details as project memories`;
  }
  return null;
};

/** The bot's project `ref` names: its id, or its name (any case). */
export const findProject = (projects: ReadonlyArray<Project>, ref: string): Project | undefined => {
  const wanted = ref.trim();
  return projects.find((p) => p.id === wanted) ?? projects.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
};

/**
 * Projects: long-standing work under a bot. The orchestrator's prompt lists them by name and
 * summary; their context and memories reach only the sessions started in them.
 */
const make = Effect.gen(function* () {
  const store = yield* Store;
  const manager = yield* SessionManager;
  const appSettings = yield* AppSettings;
  const changes = yield* PubSub.unbounded<ProjectsChange>();

  const publish = (change: ProjectsChange) => PubSub.publish(changes, change).pipe(Effect.asVoid);

  const workspace = (path: string | null | undefined) =>
    Effect.gen(function* () {
      if (path === null || path === undefined || !path.trim()) return null;
      const cwd = appSettings.expand(path);
      if (!isAbsolute(cwd)) return yield* invalid(`use a full path for the project's workspace: ${cwd}`);
      yield* Effect.try({
        try: () => mkdirSync(cwd, { recursive: true }),
        catch: (error) => invalid(`cannot create ${cwd}: ${(error as Error).message}`),
      });
      return cwd;
    });

  const resolve = (botId: BotId, ref: string) =>
    Effect.gen(function* () {
      const project = findProject(yield* store.listProjects(botId), ref);
      if (!project) return yield* new ApolloError({ code: "not_found", message: `no project "${ref}" (see apollo_project_list)` });
      return project;
    });

  const create = (input: CreateProjectInput) =>
    Effect.gen(function* () {
      yield* store.getBot(input.botId);
      const fields = { name: oneLine(input.name), summary: oneLine(input.summary), context: (input.context ?? "").trim() };
      const problem = projectProblem(fields, yield* store.listProjects(input.botId));
      if (problem) return yield* invalid(problem);
      const now = Date.now();
      const project = yield* store.insertProject({
        id: newId<ProjectId>("prj"),
        botId: input.botId,
        ...fields,
        cwd: yield* workspace(input.cwd),
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      yield* publish({ _tag: "ProjectUpserted", project });
      return project;
    });

  const update = (input: UpdateProjectInput) =>
    Effect.gen(function* () {
      const current = yield* store.getProject(input.projectId);
      const fields = {
        name: input.name !== undefined ? oneLine(input.name) : current.name,
        summary: input.summary !== undefined ? oneLine(input.summary) : current.summary,
        context: input.context !== undefined ? input.context.trim() : current.context,
      };
      const others = (yield* store.listProjects(current.botId)).filter((p) => p.id !== current.id);
      const problem = projectProblem(fields, others);
      if (problem) return yield* invalid(problem);
      const project = yield* store.updateProject({
        ...current,
        ...fields,
        cwd: input.cwd !== undefined ? yield* workspace(input.cwd) : current.cwd,
        status: input.status ?? current.status,
        updatedAt: Date.now(),
      });
      yield* publish({ _tag: "ProjectUpserted", project });
      return project;
    });

  const remove = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* store.getProject(projectId);
      const inside = (yield* store.listSessions(project.botId)).filter((s) => s.projectId === projectId);
      yield* store.deleteProject(projectId);
      for (const s of inside) {
        yield* manager.publish({ _tag: "SessionUpserted", session: yield* store.getSession(s.id) });
      }
      yield* manager.publishMemoryChanged(project.botId);
      yield* publish({ _tag: "ProjectDeleted", projectId, botId: project.botId });
    });

  return {
    list: (botId: BotId) => store.listProjects(botId),
    get: store.getProject,
    resolve,
    create,
    update,
    remove,
    /** `projects.watch`: every project, then each change, without gaps. */
    watch: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const first: ProjectsChange = { _tag: "ProjectsSnapshot", projects: yield* store.listProjects() };
        return Stream.concat(Stream.succeed(first), Stream.fromSubscription(subscription));
      }),
    ) as Stream.Stream<ProjectsChange>,
  };
});

export class Projects extends Context.Service<Projects, Effect.Success<typeof make>>()("apollo/Projects") {}

export const layer = Layer.effect(Projects, make);
