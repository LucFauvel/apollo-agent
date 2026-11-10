import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AppChange, Project, ProjectsChange, ProviderKind } from "@apollo/contracts";
import { ProviderKind as Kinds } from "@apollo/contracts";
import type { Provider, ProviderSessionOptions } from "@apollo/providers";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AppSettings from "../AppSettings.ts";
import { ServerConfig } from "../Config.ts";
import * as Database from "../Database.ts";
import * as SessionManager from "../SessionManager.ts";
import * as Store from "../Store.ts";
import { McpCaller } from "../mcp/Caller.ts";
import * as ProjectTools from "../mcp/ProjectTools.ts";
import { findProject, projectProblem } from "./Projects.ts";
import * as Projects from "./Projects.ts";

/** A provider that records how each session was opened and ends each turn at once. */
const recording = (kind: ProviderKind, opened: Array<ProviderSessionOptions>): Provider => ({
  kind,
  listModels: Effect.succeed([]),
  open: (options, emit) =>
    Effect.sync(() => {
      opened.push(options);
      const agent = (event: AgentEvent) => emit({ _tag: "Event", event });
      return {
        send: () =>
          Effect.gen(function* () {
            yield* agent({ _tag: "TurnStarted" });
            yield* agent({ _tag: "TurnCompleted", outcome: "completed", error: null });
          }),
        interrupt: Effect.void,
        respondApproval: () => Effect.void,
        respondInput: () => Effect.void,
        compact: () => Effect.void,
        commands: Effect.succeed([]),
        reloadSkills: Effect.void,
      };
    }),
});

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "apollo-projects-"));
  const cwd = join(dir, "workspace");
  mkdirSync(cwd);
  const opened: Array<ProviderSessionOptions> = [];
  const layer = Projects.layer.pipe(
    Layer.provideMerge(SessionManager.layer),
    Layer.provideMerge(
      Layer.succeed(
        SessionManager.Providers,
        Object.fromEntries(Kinds.literals.map((k) => [k, recording(k, opened)])) as Record<ProviderKind, Provider>,
      ),
    ),
    Layer.provideMerge(AppSettings.layer),
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(Database.layerMemory),
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
        storage: { budgetBytes: 1e9, archiveLimit: 2000, detailRetentionMs: 30 * 86_400_000 },
      }),
    ),
  );
  return { dir, cwd, opened, layer };
};

const setup = (cwd: string) =>
  Effect.gen(function* () {
    const manager = yield* SessionManager.SessionManager;
    const projects = yield* Projects.Projects;
    const store = yield* Store.Store;
    const changes: Array<AppChange> = [];
    const projectChanges: Array<ProjectsChange> = [];
    yield* Stream.runForEach(manager.changes, (c) => Effect.sync(() => void changes.push(c))).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Stream.runForEach(projects.watch, (c) => Effect.sync(() => void projectChanges.push(c))).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const bot = yield* manager.createBot({
      name: "Planner",
      instructions: "",
      cwd,
      main: { provider: "claude" },
      defaultWorker: { provider: "codex" },
      runtimeMode: "full-access",
      autoLearn: false,
    });
    return { manager, projects, store, bot, changes, projectChanges };
  });

const until = (test: () => boolean, ms = 5000) =>
  Effect.promise(async () => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      if (test()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out");
  });

describe("projects", () => {
  it("checks names, summaries and context sizes", () => {
    const fields = { name: "Send", summary: "File sharing", context: "" };
    expect(projectProblem(fields, [])).toBeNull();
    expect(projectProblem({ ...fields, name: "" }, [])).toContain("needs a name");
    expect(projectProblem(fields, [{ name: "send" }])).toContain('already has a project named "Send"');
    expect(projectProblem({ ...fields, summary: "x".repeat(301) }, [])).toContain("under 300");
    expect(projectProblem({ ...fields, context: "x".repeat(20_001) }, [])).toContain("over the 20000 limit");
  });

  it("finds a project by id or by name in any case", () => {
    const projects = [{ id: "prj_1", name: "Passkeys" }, { id: "prj_2", name: "Send" }] as unknown as Array<Project>;
    expect(findProject(projects, "prj_2")?.name).toBe("Send");
    expect(findProject(projects, " passkeys ")?.id).toBe("prj_1");
    expect(findProject(projects, "PAM")).toBeUndefined();
  });

  it.live("streams every project, then each change", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { projects, bot, projectChanges } = yield* setup(f.cwd);
      yield* until(() => projectChanges.length > 0);
      expect(projectChanges[0]).toEqual({ _tag: "ProjectsSnapshot", projects: [] });
      const created = yield* projects.create({ botId: bot.id, name: "  Send ", summary: "File  sharing\nfor teams" });
      expect(created).toMatchObject({ name: "Send", summary: "File sharing for teams", context: "", cwd: null, status: "active" });
      const updated = yield* projects.update({ projectId: created.id, context: "## Goals\n- ship", status: "archived" });
      expect(updated).toMatchObject({ context: "## Goals\n- ship", status: "archived", summary: "File sharing for teams" });
      const duplicate = yield* Effect.flip(projects.create({ botId: bot.id, name: "send", summary: "" }));
      expect(duplicate.message).toContain("already has a project");
      yield* until(() => projectChanges.length === 3);
      expect(projectChanges.slice(1).map((c) => c._tag)).toEqual(["ProjectUpserted", "ProjectUpserted"]);
    }).pipe(Effect.provide(f.layer));
  });

  it.live("starts sessions in the project's workspace, with its context; the orchestrator sees only its summary", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, projects, bot } = yield* setup(f.cwd);
      const project = yield* projects.create({
        botId: bot.id,
        name: "Passkeys",
        summary: "Passkey sign-in for the web app; beta in December",
        context: "Decision: WebAuthn level 3 only. The spec lives in docs/passkeys.md.",
        cwd: join(f.dir, "passkeys"),
      });
      const worker = yield* manager.createSession({
        botId: bot.id,
        title: "Spec review",
        provider: { provider: "codex" },
        projectId: project.id,
        prompt: "review the spec",
      });
      expect(worker.projectId).toBe(project.id);
      expect(worker.cwd).toBe(join(f.dir, "passkeys"));
      yield* until(() => f.opened.length === 1);
      const workerPrompt = f.opened[0]!.instructions;
      expect(workerPrompt).toContain("## Project: Passkeys");
      expect(workerPrompt).toContain("Decision: WebAuthn level 3 only.");
      expect(workerPrompt).toContain("scope `project`");

      yield* manager.send(bot.mainSessionId, "hello", "user");
      yield* until(() => f.opened.length === 2);
      const mainPrompt = f.opened[1]!.instructions;
      expect(mainPrompt).toContain(`- Passkeys (\`${project.id}\`): Passkey sign-in for the web app; beta in December`);
      expect(mainPrompt).not.toContain("WebAuthn level 3");
      expect(mainPrompt).not.toContain("## Project:");
    }).pipe(Effect.provide(f.layer));
  });

  it.live("refuses a project of another bot", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, projects, bot } = yield* setup(f.cwd);
      const other = yield* manager.createBot({
        name: "Other",
        instructions: "",
        cwd: f.cwd,
        main: { provider: "claude" },
        defaultWorker: { provider: "codex" },
        runtimeMode: "full-access",
        autoLearn: false,
      });
      const project = yield* projects.create({ botId: other.id, name: "Theirs", summary: "" });
      const error = yield* Effect.flip(
        manager.createSession({ botId: bot.id, title: "x", provider: { provider: "codex" }, projectId: project.id }),
      );
      expect(error.message).toContain("another bot");
    }).pipe(Effect.provide(f.layer));
  });

  it.live("keeps project memories in the project", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { projects, store, bot } = yield* setup(f.cwd);
      const send = yield* projects.create({ botId: bot.id, name: "Send", summary: "" });
      const pam = yield* projects.create({ botId: bot.id, name: "PAM", summary: "" });
      yield* store.insertMemory({ botId: bot.id, kind: "fact", content: "Release train ships on Tuesdays", tags: [], sourceSessionId: null });
      yield* store.insertMemory({ botId: bot.id, kind: "fact", content: "Send release uses the blue bucket", tags: [], sourceSessionId: null, projectId: send.id });
      yield* store.insertMemory({ botId: bot.id, kind: "fact", content: "PAM release needs a security review", tags: [], sourceSessionId: null, projectId: pam.id });

      const contents = (found: ReadonlyArray<{ content: string }>) => found.map((m) => m.content).sort();
      expect(contents(yield* store.searchMemories(bot.id, "release", 10))).toEqual(["Release train ships on Tuesdays"]);
      expect(contents(yield* store.searchMemories(bot.id, "release", 10, send.id))).toEqual([
        "Release train ships on Tuesdays",
        "Send release uses the blue bucket",
      ]);
      // The same fact saved in two projects is two memories.
      const again = yield* store.insertMemory({ botId: bot.id, kind: "fact", content: "Send release uses the blue bucket", tags: [], sourceSessionId: null, projectId: pam.id });
      expect(again.projectId).toBe(pam.id);
      expect((yield* store.projectMemories(pam.id, 10)).length).toBe(2);
    }).pipe(Effect.provide(f.layer));
  });

  it.live("deleting a project deletes its memories and moves its sessions out of it", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, projects, store, bot, changes, projectChanges } = yield* setup(f.cwd);
      const project = yield* projects.create({ botId: bot.id, name: "Send", summary: "" });
      const worker = yield* manager.createSession({ botId: bot.id, title: "w", provider: { provider: "codex" }, projectId: project.id });
      yield* store.insertMemory({ botId: bot.id, kind: "fact", content: "Send uses S3", tags: [], sourceSessionId: null, projectId: project.id });
      yield* projects.remove(project.id);
      expect((yield* store.getSession(worker.id)).projectId).toBeNull();
      expect(yield* store.projectMemories(project.id, 10)).toEqual([]);
      yield* until(() => projectChanges.some((c) => c._tag === "ProjectDeleted"));
      yield* until(() => changes.some((c) => c._tag === "SessionUpserted" && c.session.id === worker.id && c.session.projectId === null));
    }).pipe(Effect.provide(f.layer));
  });

  it.live("go with their bot", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, projects, store, bot } = yield* setup(f.cwd);
      yield* projects.create({ botId: bot.id, name: "Send", summary: "" });
      yield* manager.deleteBot(bot.id);
      expect(yield* store.listProjects()).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  });
});

describe("project tools", () => {
  const call = (caller: McpCaller["Service"], name: string, params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const toolkit = yield* ProjectTools.ProjectToolkit;
      const stream = yield* toolkit.handle(name as never, params as never);
      const results = Array.from(yield* Stream.runCollect(stream));
      const last = results.at(-1)!;
      return { failed: last.isFailure, result: last.result as Record<string, unknown> };
    }).pipe(Effect.provideService(McpCaller, caller), Effect.provide(ProjectTools.handlers));

  it.live("let the orchestrator start projects, and keep a project's sessions to their own", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, projects, bot } = yield* setup(f.cwd);
      const main = { sessionId: bot.mainSessionId, botId: bot.id, role: "main" as const };
      const created = yield* call(main, "apollo_project_create", { name: "Send", summary: "File sharing" });
      expect(created.failed).toBe(false);
      const other = yield* projects.create({ botId: bot.id, name: "PAM", summary: "" });

      const worker = yield* manager.createSession({
        botId: bot.id,
        title: "w",
        provider: { provider: "codex" },
        projectId: created.result.id as never,
      });
      const inProject = { sessionId: worker.id, botId: bot.id, role: "worker" as const };
      expect((yield* call(inProject, "apollo_project_create", { name: "X", summary: "" })).failed).toBe(true);

      yield* call(inProject, "apollo_project_update", { append: "Decided: S3." });
      const appended = yield* call(inProject, "apollo_project_update", { append: "Beta on Friday." });
      expect(appended.failed).toBe(false);
      const read = yield* call(inProject, "apollo_project_read", {});
      expect(read.result.context).toBe("Decided: S3.\n\nBeta on Friday.");

      const elsewhere = yield* call(inProject, "apollo_project_read", { project: "PAM" });
      expect(elsewhere.failed).toBe(true);
      expect(String((elsewhere.result as { message?: string }).message)).toContain("its own project");
      // The orchestrator reaches any of the bot's projects.
      expect((yield* call(main, "apollo_project_read", { project: other.id })).failed).toBe(false);
      expect((yield* call(main, "apollo_project_read", {})).failed).toBe(true);
    }).pipe(Effect.provide(f.layer));
  });
});
