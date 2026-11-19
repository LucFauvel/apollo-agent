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
  type Session,
  type SessionId,
  type UpdateProjectInput,
} from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

/** The context changed under an edit: `projects.update` with `expectedContext` refuses to overwrite it. */
export const CONTEXT_CONFLICT = "the project's context changed since you started editing it (an agent may have updated it)";

/** Why a session cannot lead the project, or null. */
export const leadProblem = (
  project: Pick<Project, "id" | "botId">,
  session: Option.Option<Pick<Session, "botId" | "role" | "projectId">>,
): string | null => {
  if (Option.isNone(session)) return "no such session";
  if (session.value.botId !== project.botId) return "that session belongs to another bot";
  if (session.value.role !== "worker") return "only a worker session can lead a project";
  if (session.value.projectId !== project.id) return "a project's lead must be one of its sessions: start it in the project";
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

  /** The orchestrator's prompt lists the bot's projects: a change reaches it from its next turn. */
  const refreshOrchestrator = (botId: BotId) =>
    store.getBot(botId).pipe(
      Effect.flatMap((bot) => manager.refreshInstructions(bot.mainSessionId)),
      Effect.catch(() => Effect.void),
    );

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
        leadSessionId: null,
        createdAt: now,
        updatedAt: now,
      });
      yield* publish({ _tag: "ProjectUpserted", project });
      yield* refreshOrchestrator(project.botId);
      return project;
    });

  /**
   * Project writes read the project and write it whole: one at a time, so none undoes another.
   * The lock is the manager's lead lock, so storage eviction never deletes a new lead.
   */
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => manager.withLeadLock(effect);

  /**
   * A new lead reports its turns to the orchestrator, which hands it the project's work: a
   * session the user started has no parent, and a lead's own workers report to it instead.
   * One the orchestrator started keeps its own choice (`notifyOnCompletion: false` stays off).
   */
  const reportToOrchestrator = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const session = yield* store.getSession(sessionId);
      const bot = yield* store.getBot(session.botId);
      if (session.parentSessionId === bot.mainSessionId) return;
      yield* manager.publish({ _tag: "SessionUpserted", session: yield* store.reportTo(sessionId, bot.mainSessionId) });
    });

  /** `onlyIfNoLead`: refused when the project already has a lead (checked with the write). */
  const update = (input: UpdateProjectInput, options: { readonly onlyIfNoLead?: boolean } = {}) =>
    Effect.gen(function* () {
      const { current, project } = yield* locked(
        Effect.gen(function* () {
          const current = yield* store.getProject(input.projectId);
          if (input.context !== undefined && input.expectedContext !== undefined && input.expectedContext.trim() !== current.context) {
            return yield* invalid(CONTEXT_CONFLICT);
          }
          if (options.onlyIfNoLead && current.leadSessionId) {
            return yield* invalid(`${current.name} already has a lead (${current.leadSessionId})`);
          }
          const fields = {
            name: input.name !== undefined ? oneLine(input.name) : current.name,
            summary: input.summary !== undefined ? oneLine(input.summary) : current.summary,
            context: input.context !== undefined ? input.context.trim() : current.context,
          };
          const others = (yield* store.listProjects(current.botId)).filter((p) => p.id !== current.id);
          const problem = projectProblem(fields, others);
          if (problem) return yield* invalid(problem);
          const previousLead = current.leadSessionId ?? null;
          const lead = input.leadSessionId !== undefined ? input.leadSessionId : previousLead;
          if (lead !== null && lead !== previousLead) {
            const problem = leadProblem(current, yield* Effect.option(store.getSession(lead)));
            if (problem) return yield* invalid(problem);
            if (yield* manager.isEvicting(lead)) return yield* invalid("that session is being deleted to free storage");
          }
          const project = yield* store.updateProject({
            ...current,
            ...fields,
            cwd: input.cwd !== undefined ? yield* workspace(input.cwd) : current.cwd,
            status: input.status ?? current.status,
            leadSessionId: lead,
            updatedAt: Date.now(),
          });
          yield* publish({ _tag: "ProjectUpserted", project });
          return { current, project };
        }),
      );
      const previousLead = current.leadSessionId ?? null;
      const lead = project.leadSessionId ?? null;
      if (lead && lead !== previousLead) yield* reportToOrchestrator(lead);
      // Only what the orchestrator's prompt shows; the context is not in it.
      if (
        project.name !== current.name ||
        project.summary !== current.summary ||
        project.cwd !== current.cwd ||
        project.status !== current.status ||
        lead !== previousLead
      ) {
        yield* refreshOrchestrator(project.botId);
      }
      // A lead's prompt says it leads the project, and how.
      if (lead !== previousLead) {
        if (previousLead) yield* manager.refreshInstructions(previousLead);
        if (lead) yield* manager.refreshInstructions(lead);
      }
      return project;
    });

  const remove = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* store.getProject(projectId);
      yield* manager.deletingProject(
        projectId,
        Effect.gen(function* () {
          const inside = (yield* store.listSessions(project.botId)).filter((s) => s.projectId === projectId);
          yield* store.deleteProject(projectId);
          for (const s of inside) {
            yield* manager.publish({ _tag: "SessionUpserted", session: yield* store.getSession(s.id) });
            // Their prompt still shows the project.
            yield* manager.refreshInstructions(s.id);
          }
          yield* manager.publishMemoryChanged(project.botId);
          yield* publish({ _tag: "ProjectDeleted", projectId, botId: project.botId });
          yield* refreshOrchestrator(project.botId);
        }),
      );
    });

  /** Its lead's session went: the project has no lead. */
  const leadGone = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const cleared = yield* locked(
        Effect.gen(function* () {
          const saved: Array<Project> = [];
          for (const project of yield* store.listProjects()) {
            if (project.leadSessionId !== sessionId) continue;
            saved.push(yield* store.updateProject({ ...project, leadSessionId: null, updatedAt: Date.now() }));
            yield* publish({ _tag: "ProjectUpserted", project: saved.at(-1)! });
          }
          return saved;
        }),
      );
      for (const project of cleared) yield* refreshOrchestrator(project.botId);
    });

  {
    const known = new Set((yield* store.listSessions()).map((s) => s.id));
    for (const project of yield* store.listProjects()) {
      if (project.leadSessionId && !known.has(project.leadSessionId)) {
        yield* store.updateProject({ ...project, leadSessionId: null });
      }
    }
  }
  yield* Stream.runForEach(manager.changes, (change) =>
    change._tag === "SessionDeleted" ? leadGone(change.sessionId).pipe(Effect.catch(() => Effect.void)) : Effect.void,
  ).pipe(Effect.forkScoped);

  /** The project a session leads, if any. */
  const ledBy = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const session = yield* store.getSession(sessionId);
      if (!session.projectId) return null;
      const project = yield* store.getProject(session.projectId);
      return project.leadSessionId === sessionId ? project : null;
    });

  return {
    list: (botId: BotId) => store.listProjects(botId),
    ledBy,
    /** Makes the session the project's lead, unless the project has one (checked atomically). */
    claimLead: (projectId: ProjectId, sessionId: SessionId) => update({ projectId, leadSessionId: sessionId }, { onlyIfNoLead: true }),
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
