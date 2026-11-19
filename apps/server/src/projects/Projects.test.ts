import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AppChange, Project, ProjectsChange, ProviderKind, SessionId } from "@apollo/contracts";
import { ProviderKind as Kinds } from "@apollo/contracts";
import type { Provider, ProviderSessionOptions } from "@apollo/providers";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AppSettings from "../AppSettings.ts";
import { ServerConfig } from "../Config.ts";
import * as Database from "../Database.ts";
import * as SessionManager from "../SessionManager.ts";
import * as Store from "../Store.ts";
import { McpCaller } from "../mcp/Caller.ts";
import * as ApolloMcp from "../mcp/ApolloMcp.ts";
import * as ProjectTools from "../mcp/ProjectTools.ts";
import * as Scheduler from "../schedule/Scheduler.ts";
import { findProject, projectProblem } from "./Projects.ts";
import * as Projects from "./Projects.ts";

/** Holds providers' startup while `wait` is pending; `started` counts opens begun. */
interface StartGate {
  wait: Promise<void>;
  started: number;
}

/** A provider that records how each session was opened and ends each turn at once. */
const recording = (kind: ProviderKind, opened: Array<ProviderSessionOptions>, gate: StartGate): Provider => ({
  kind,
  listModels: Effect.succeed([]),
  open: (options, emit) =>
    Effect.gen(function* () {
      gate.started++;
      yield* Effect.promise(() => gate.wait);
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
  const gate: StartGate = { wait: Promise.resolve(), started: 0 };
  const layer = Projects.layer.pipe(
    Layer.provideMerge(SessionManager.layer),
    Layer.provideMerge(
      Layer.succeed(
        SessionManager.Providers,
        Object.fromEntries(Kinds.literals.map((k) => [k, recording(k, opened, gate)])) as Record<ProviderKind, Provider>,
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
  return { dir, cwd, opened, gate, layer };
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

describe("project changes", () => {
  it.live("refuse a context edit made from an older context", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { projects, bot } = yield* setup(f.cwd);
      const project = yield* projects.create({ botId: bot.id, name: "Send", summary: "", context: "Goals: ship" });
      yield* projects.update({ projectId: project.id, context: "Goals: ship\n\nDecided: S3.", expectedContext: "Goals: ship" });
      const stale = yield* Effect.flip(
        projects.update({ projectId: project.id, context: "Goals: ship by Friday", expectedContext: "Goals: ship" }),
      );
      expect(stale.message).toContain("changed since you started editing");
      expect((yield* projects.get(project.id)).context).toBe("Goals: ship\n\nDecided: S3.");
      // Other fields alone leave the context as it is.
      const renamed = yield* projects.update({ projectId: project.id, name: "Send v2" });
      expect(renamed.context).toBe("Goals: ship\n\nDecided: S3.");
    }).pipe(Effect.provide(f.layer));
  });

  it.live("reach a running orchestrator from its next turn, unless only the context changed", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, projects, store, bot } = yield* setup(f.cwd);
      const turn = (n: number) =>
        Effect.gen(function* () {
          yield* manager.send(bot.mainSessionId, `message ${n}`, "user");
          yield* until(() => f.opened.length >= 1);
          yield* Effect.promise(async () => {
            for (let i = 0; i < 200; i++) {
              const s = await Effect.runPromise(store.getSession(bot.mainSessionId));
              if (s.status === "idle" && s.completedTurns >= n) return;
              await new Promise((r) => setTimeout(r, 10));
            }
            throw new Error("turn did not end");
          });
        });
      yield* turn(1);
      expect(f.opened.at(-1)!.instructions).toContain("No active projects yet.");

      const project = yield* projects.create({ botId: bot.id, name: "Send", summary: "File sharing" });
      yield* turn(2);
      expect(f.opened).toHaveLength(2);
      expect(f.opened.at(-1)!.instructions).toContain("- Send (");

      yield* projects.update({ projectId: project.id, context: "Details only sessions in the project see." });
      yield* turn(3);
      expect(f.opened).toHaveLength(2);

      yield* projects.update({ projectId: project.id, status: "archived" });
      yield* turn(4);
      expect(f.opened).toHaveLength(3);
      expect(f.opened.at(-1)!.instructions).toContain("No active projects yet.");
    }).pipe(Effect.provide(f.layer));
  });
});

/** A repository whose checkouts take `seconds`, so a worktree is still being created for a while. */
const slowRepo = (dir: string, seconds: number) => {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  execSync("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repo });
  const hook = join(repo, ".git", "hooks", "post-checkout");
  writeFileSync(hook, `#!/bin/sh\nsleep ${seconds}\n`);
  chmodSync(hook, 0o755);
  return repo;
};

const worktrees = (repo: string) => execSync("git worktree list --porcelain", { cwd: repo }).toString().split("\n").filter((l) => l.startsWith("worktree ")).length;
const branches = (repo: string) => execSync("git branch --list 'apollo/*'", { cwd: repo }).toString().trim();

describe("a project change while the orchestrator starts", () => {
  it.live("opens it again with the new project list", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, projects, store, bot } = yield* setup(f.cwd);
      let release!: () => void;
      f.gate.wait = new Promise((resolve) => (release = resolve));
      const sending = yield* manager.send(bot.mainSessionId, "hello", "user").pipe(Effect.forkChild({ startImmediately: true }));
      yield* until(() => f.gate.started === 1);
      yield* projects.create({ botId: bot.id, name: "Send", summary: "File sharing" });
      release();
      yield* Fiber.join(sending);
      const idle = () =>
        Effect.promise(async () => {
          for (let i = 0; i < 300; i++) {
            if ((await Effect.runPromise(store.getSession(bot.mainSessionId))).status === "idle") return;
            await new Promise((r) => setTimeout(r, 10));
          }
          throw new Error("still busy");
        });
      yield* idle();
      // The process that was starting read no projects; it was replaced before serving a turn.
      expect(f.opened).toHaveLength(2);
      expect(f.opened[0]!.instructions).toContain("No active projects yet.");
      expect(f.opened[1]!.instructions).toContain("- Send (");
      // The process that runs from then on is the fresh one.
      yield* manager.send(bot.mainSessionId, "again", "user");
      yield* idle();
      expect(f.opened).toHaveLength(2);
    }).pipe(Effect.provide(f.layer));
  });
});

describe("project changes during every retried start", () => {
  it.live.each([
    ["a message", true],
    ["the slash command list", false],
  ] as const)("still reach the orchestrator, from its next turn (opened for %s)", (_, forTurn) => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, projects, store, bot } = yield* setup(f.cwd);
      const idle = () =>
        Effect.promise(async () => {
          for (let i = 0; i < 300; i++) {
            if ((await Effect.runPromise(store.getSession(bot.mainSessionId))).status === "idle") return;
            await new Promise((r) => setTimeout(r, 10));
          }
          throw new Error("still busy");
        });
      const hold = () => {
        let release!: () => void;
        f.gate.wait = new Promise((resolve) => (release = resolve));
        return release;
      };
      let release = hold();
      const opening = forTurn ? manager.send(bot.mainSessionId, "hello", "user") : manager.listCommands(bot.mainSessionId);
      const sending = yield* Effect.asVoid(opening).pipe(Effect.forkChild({ startImmediately: true }));
      yield* until(() => f.gate.started === 1);
      const project = yield* projects.create({ botId: bot.id, name: "Send v1", summary: "" });
      for (const [start, name] of [[2, "Send v2"], [3, "Send v3"]] as const) {
        const previous = release;
        release = hold();
        previous();
        yield* until(() => f.gate.started === start);
        yield* projects.update({ projectId: project.id, name });
      }
      f.gate.wait = Promise.resolve();
      release();
      yield* Fiber.join(sending);
      yield* idle();
      // The third start gives up retrying and serves what it was opened for.
      expect(f.opened).toHaveLength(3);
      expect(f.opened[2]!.instructions).toContain("Send v2");

      yield* manager.send(bot.mainSessionId, "again", "user");
      yield* idle();
      expect(f.opened).toHaveLength(4);
      expect(f.opened[3]!.instructions).toContain("Send v3");

      yield* manager.send(bot.mainSessionId, "once more", "user");
      yield* idle();
      expect(f.opened).toHaveLength(4);
    }).pipe(Effect.provide(f.layer));
  });
});

describe.skipIf(process.platform === "win32")("deleting a project while a session is created in it", () => {
  it.live("waits for the session, then moves it out of the project", () => {
    const f = fixture();
    const repo = slowRepo(f.dir, 0.4);
    return Effect.gen(function* () {
      const { manager, projects, store, bot } = yield* setup(f.cwd);
      const project = yield* projects.create({ botId: bot.id, name: "Send", summary: "", cwd: repo });
      const creating = yield* manager
        .createSession({ botId: bot.id, title: "w", provider: { provider: "codex" }, projectId: project.id, isolation: "worktree" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* until(() => existsSync(join(f.dir, "worktrees")));
      yield* projects.remove(project.id);
      const session = yield* Fiber.join(creating);
      expect((yield* store.getSession(session.id)).projectId).toBeNull();
      expect(existsSync(session.worktree!.path)).toBe(true);
      const late = yield* Effect.flip(manager.createSession({ botId: bot.id, title: "x", provider: { provider: "codex" }, projectId: project.id }));
      expect(late.code).toBe("not_found");
    }).pipe(Effect.provide(f.layer));
  });

  it.live("removes the new worktree when the session cannot be saved", () => {
    const f = fixture();
    const repo = slowRepo(f.dir, 0.4);
    return Effect.gen(function* () {
      const { manager, projects, store, bot } = yield* setup(f.cwd);
      const project = yield* projects.create({ botId: bot.id, name: "Send", summary: "", cwd: repo });
      const creating = yield* manager
        .createSession({ botId: bot.id, title: "w", provider: { provider: "codex" }, projectId: project.id, isolation: "worktree" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* until(() => existsSync(join(f.dir, "worktrees")));
      // Behind the manager's back: the insert then fails its foreign key.
      yield* store.deleteProject(project.id);
      const error = yield* Effect.flip(Fiber.join(creating));
      expect(error.message).toContain("could not save the session");
      expect(worktrees(repo)).toBe(1);
      expect(branches(repo)).toBe("");
    }).pipe(Effect.provide(f.layer));
  });
});

describe.skipIf(process.platform === "win32")("interrupting a session's creation", () => {
  it.live("removes the worktree it was creating", () => {
    const f = fixture();
    const repo = slowRepo(f.dir, 0.4);
    return Effect.gen(function* () {
      const { manager, projects, store, bot } = yield* setup(f.cwd);
      const project = yield* projects.create({ botId: bot.id, name: "Send", summary: "", cwd: repo });
      const creating = yield* manager
        .createSession({ botId: bot.id, title: "w", provider: { provider: "codex" }, projectId: project.id, isolation: "worktree" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* until(() => existsSync(join(f.dir, "worktrees")));
      yield* Fiber.interrupt(creating);
      yield* projects.remove(project.id);
      expect((yield* store.listSessions(bot.id)).map((s) => s.id)).toEqual([bot.mainSessionId]);
      expect(worktrees(repo)).toBe(1);
      expect(branches(repo)).toBe("");
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

describe("project leads", () => {
  const withTools = (f: ReturnType<typeof fixture>) =>
    Scheduler.layerWith({ tickEvery: null, taskTimeout: "5 seconds", heartbeatTimeout: "5 seconds" }).pipe(Layer.provideMerge(f.layer));

  type Called = { failed: boolean; result: Record<string, unknown> & { message?: string } };
  const collect = (stream: Stream.Stream<{ readonly isFailure: boolean; readonly result: unknown }, unknown>) =>
    Effect.map(Stream.runCollect(stream), (results): Called => {
      const last = Array.from(results).at(-1)!;
      return { failed: last.isFailure, result: last.result as Called["result"] };
    });
  const call = (caller: McpCaller["Service"], name: string, params: Record<string, unknown>) =>
    (name.startsWith("apollo_project_")
      ? Effect.gen(function* () {
          const toolkit = yield* ProjectTools.ProjectToolkit;
          return yield* collect(yield* toolkit.handle(name as never, params as never));
        }).pipe(Effect.provide(ProjectTools.handlers))
      : Effect.gen(function* () {
          const toolkit = yield* ApolloMcp.ApolloToolkit;
          return yield* collect(yield* toolkit.handle(name as never, params as never));
        }).pipe(Effect.provide(ApolloMcp.handlers))
    ).pipe(Effect.provideService(McpCaller, caller));

  it.live("own their project: they start its workers, which report to them", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, projects, store, bot, projectChanges } = yield* setup(f.cwd);
      const send = yield* projects.create({ botId: bot.id, name: "Send", summary: "File sharing" });
      yield* projects.create({ botId: bot.id, name: "PAM", summary: "" });
      const main = { sessionId: bot.mainSessionId, botId: bot.id, role: "main" as const };

      const spawned = yield* call(main, "apollo_spawn_session", { title: "Send lead", prompt: "plan the beta", project: "Send", lead: true });
      expect(spawned.failed).toBe(false);
      const leadId = spawned.result.id as SessionId;
      expect((yield* projects.get(send.id)).leadSessionId).toBe(leadId);
      expect((yield* store.getSession(leadId)).projectId).toBe(send.id);
      // Its first turn already runs as the lead.
      yield* until(() => f.opened.length >= 1);
      expect(f.opened[0]!.instructions).toContain("## Your role: lead of Send");

      const second = yield* call(main, "apollo_spawn_session", { title: "x", prompt: "x", project: "Send", lead: true });
      expect(second.result.message).toContain("already has a lead");

      const leadCaller = { sessionId: leadId, botId: bot.id, role: "worker" as const };
      const elsewhere = yield* call(leadCaller, "apollo_spawn_session", { title: "x", prompt: "x", project: "PAM" });
      expect(elsewhere.result.message).toContain("only in its project");
      expect((yield* call(leadCaller, "apollo_spawn_session", { title: "x", prompt: "x", lead: true })).result.message).toContain(
        "cannot start another lead",
      );

      const leadTurns = (yield* store.getSession(leadId)).completedTurns;
      const worker = yield* call(leadCaller, "apollo_spawn_session", { title: "Upload API", prompt: "build it" });
      expect(worker.failed).toBe(false);
      const workerSession = yield* store.getSession(worker.result.id as SessionId);
      expect(workerSession).toMatchObject({ projectId: send.id, parentSessionId: leadId });
      yield* until(() => f.opened.some((o) => o.instructions.includes("started by the lead of Send")));
      // Its finished turn is reported to the lead, which answers in a turn of its own.
      yield* Effect.promise(async () => {
        for (let i = 0; i < 300; i++) {
          if ((await Effect.runPromise(store.getSession(leadId))).completedTurns > leadTurns) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("the lead got no report");
      });

      const plain = { sessionId: workerSession.id, botId: bot.id, role: "worker" as const };
      const refused = yield* call(plain, "apollo_spawn_session", { title: "x", prompt: "x" });
      expect(refused.result.message).toContain("or a project lead");

      yield* manager.send(bot.mainSessionId, "hello", "user");
      yield* until(() => f.opened.some((o) => o.instructions.includes("## Your role: orchestrator")));
      expect(f.opened.find((o) => o.instructions.includes("## Your role: orchestrator"))!.instructions).toContain(
        `Lead: session \`${leadId}\`.`,
      );

      yield* manager.deleteSession(leadId);
      yield* until(() => projectChanges.some((c) => c._tag === "ProjectUpserted" && c.project.id === send.id && c.project.leadSessionId === null));
      expect((yield* projects.get(send.id)).leadSessionId).toBeNull();
    }).pipe(Effect.provide(withTools(f)));
  });

  it.live("report to the orchestrator once promoted, wherever they reported before", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, projects, store, bot } = yield* setup(f.cwd);
      const send = yield* projects.create({ botId: bot.id, name: "Send", summary: "" });
      const fromUi = yield* manager.createSession({ botId: bot.id, title: "u", provider: { provider: "codex" }, projectId: send.id });
      expect(fromUi.parentSessionId).toBeNull();
      yield* projects.update({ projectId: send.id, leadSessionId: fromUi.id });
      expect((yield* store.getSession(fromUi.id)).parentSessionId).toBe(bot.mainSessionId);
      expect(yield* store.notifiesParent(fromUi.id)).toBe(true);

      // Delegated through apollo_send_to_session, its finished turn comes back to the orchestrator.
      yield* manager.send(fromUi.id, "plan the beta", "bot");
      yield* until(() => f.opened.some((o) => o.instructions.includes("## Your role: orchestrator")));

      const byLead = yield* manager.createSession({
        botId: bot.id,
        title: "w",
        provider: { provider: "codex" },
        projectId: send.id,
        parentSessionId: fromUi.id,
        notifyParent: true,
      });
      yield* projects.update({ projectId: send.id, leadSessionId: byLead.id });
      expect((yield* store.getSession(byLead.id)).parentSessionId).toBe(bot.mainSessionId);
    }).pipe(Effect.provide(f.layer));
  });

  it.live("are claimed by one session at a time", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, projects, bot } = yield* setup(f.cwd);
      const send = yield* projects.create({ botId: bot.id, name: "Send", summary: "" });
      const [a, b] = yield* Effect.all(
        ["a", "b"].map((title) => manager.createSession({ botId: bot.id, title, provider: { provider: "codex" }, projectId: send.id })),
      );
      const claims = yield* Effect.all([projects.claimLead(send.id, a!.id), projects.claimLead(send.id, b!.id)].map(Effect.result), {
        concurrency: "unbounded",
      });
      expect(claims.filter((c) => c._tag === "Success")).toHaveLength(1);
      expect((yield* projects.get(send.id)).leadSessionId).toBe(claims[0]!._tag === "Success" ? a!.id : b!.id);
    }).pipe(Effect.provide(f.layer));
  });

  it.live("are chosen among the project's worker sessions", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, projects, bot } = yield* setup(f.cwd);
      const send = yield* projects.create({ botId: bot.id, name: "Send", summary: "" });
      const outside = yield* manager.createSession({ botId: bot.id, title: "o", provider: { provider: "codex" } });
      const inside = yield* manager.createSession({ botId: bot.id, title: "i", provider: { provider: "codex" }, projectId: send.id });
      expect((yield* Effect.flip(projects.update({ projectId: send.id, leadSessionId: outside.id }))).message).toContain("one of its sessions");
      expect((yield* Effect.flip(projects.update({ projectId: send.id, leadSessionId: bot.mainSessionId }))).message).toContain(
        "only a worker session",
      );
      expect((yield* projects.update({ projectId: send.id, leadSessionId: inside.id })).leadSessionId).toBe(inside.id);
      expect((yield* projects.update({ projectId: send.id, summary: "File sharing" })).leadSessionId).toBe(inside.id);

      const main = { sessionId: bot.mainSessionId, botId: bot.id, role: "main" as const };
      const worker = { sessionId: inside.id, botId: bot.id, role: "worker" as const };
      expect((yield* call(worker, "apollo_project_update", { lead: "" })).result.message).toContain("only the bot's orchestrator");
      const cleared = yield* call(main, "apollo_project_update", { project: "Send", lead: "" });
      expect(cleared.result.lead).toBeNull();
      expect((yield* projects.get(send.id)).leadSessionId).toBeNull();
    }).pipe(Effect.provide(withTools(f)));
  });
});

describe.skipIf(process.platform === "win32")("two leads spawned at once", () => {
  it.live("start one lead; the other spawn fails and leaves nothing behind", () => {
    const f = fixture();
    const repo = slowRepo(f.dir, 0.4);
    const layer = Scheduler.layerWith({ tickEvery: null, taskTimeout: "5 seconds", heartbeatTimeout: "5 seconds" }).pipe(Layer.provideMerge(f.layer));
    return Effect.gen(function* () {
      const { projects, store, bot } = yield* setup(f.cwd);
      const send = yield* projects.create({ botId: bot.id, name: "Send", summary: "", cwd: repo });
      const main = { sessionId: bot.mainSessionId, botId: bot.id, role: "main" as const };
      const spawn = (title: string) =>
        Effect.gen(function* () {
          const toolkit = yield* ApolloMcp.ApolloToolkit;
          const stream = yield* toolkit.handle("apollo_spawn_session", { title, prompt: "lead it", project: "Send", lead: true, isolation: "worktree" });
          const last = Array.from(yield* Stream.runCollect(stream)).at(-1)!;
          return { failed: last.isFailure, result: last.result as { id?: SessionId; message?: string } };
        }).pipe(Effect.provideService(McpCaller, main), Effect.provide(ApolloMcp.handlers));
      const results = yield* Effect.all([spawn("one"), spawn("two")], { concurrency: "unbounded" });
      const won = results.filter((r) => !r.failed);
      expect(won).toHaveLength(1);
      expect(results.find((r) => r.failed)!.result.message).toContain("already has a lead");
      expect((yield* projects.get(send.id)).leadSessionId).toBe(won[0]!.result.id);
      const inside = (yield* store.listSessions(bot.id)).filter((s) => s.projectId === send.id);
      expect(inside.map((s) => s.id)).toEqual([won[0]!.result.id]);
      expect(worktrees(repo)).toBe(2);
    }).pipe(Effect.provide(layer));
  }, 20_000);
});
