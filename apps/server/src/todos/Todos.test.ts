import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ProviderKind, TodosChange } from "@apollo/contracts";
import { ProviderKind as Kinds } from "@apollo/contracts";
import { type Provider, ProviderError } from "@apollo/providers";
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
import * as TodoTools from "../mcp/TodoTools.ts";
import { reordered } from "./Todos.ts";
import * as Todos from "./Todos.ts";

/** A provider that records what its agent reads and ends each turn at once; `failures` sends fail first. */
const recording = (
  kind: ProviderKind,
  sent: Array<string>,
  failures: { count: number; during?: Effect.Effect<unknown, unknown> },
): Provider => ({
  kind,
  listModels: Effect.succeed([]),
  open: (_options, emit) =>
    Effect.sync(() => {
      const agent = (event: AgentEvent) => emit({ _tag: "Event", event });
      return {
        send: (text: string) =>
          Effect.gen(function* () {
            if (failures.count > 0) {
              failures.count--;
              return yield* new ProviderError({ provider: kind, message: "the agent's process went away" });
            }
            sent.push(text);
            if (failures.during) yield* Effect.ignore(failures.during);
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

/** `persistent`: the database is a file in the data directory, so a second `layer()` is Apollo after a restart. */
const fixture = ({ persistent = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "apollo-todos-"));
  const cwd = join(dir, "workspace");
  mkdirSync(cwd);
  const sent: Array<string> = [];
  const failures: { count: number; during?: Effect.Effect<unknown, unknown> } = { count: 0 };
  const layer = () => Todos.layer.pipe(
    Layer.provideMerge(SessionManager.layer),
    Layer.provideMerge(
      Layer.succeed(
        SessionManager.Providers,
        Object.fromEntries(Kinds.literals.map((k) => [k, recording(k, sent, failures)])) as Record<ProviderKind, Provider>,
      ),
    ),
    Layer.provideMerge(AppSettings.layer),
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(persistent ? Database.layer : Database.layerMemory),
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
  return { cwd, sent, failures, layer };
};

const setup = (cwd: string) =>
  Effect.gen(function* () {
    const manager = yield* SessionManager.SessionManager;
    const todos = yield* Todos.Todos;
    const changes: Array<TodosChange> = [];
    yield* Stream.runForEach(todos.watch, (c) => Effect.sync(() => void changes.push(c))).pipe(
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
    return { manager, todos, bot, changes };
  });

const until = (test: () => boolean, ms = 5000) =>
  Effect.promise(async () => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      if (test()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out");
  });

const call = (caller: McpCaller["Service"], name: string, params: Record<string, unknown>) =>
  Effect.gen(function* () {
    const toolkit = yield* TodoTools.TodoToolkit;
    const stream = yield* toolkit.handle(name as never, params as never);
    const results = Array.from(yield* Stream.runCollect(stream));
    const last = results.at(-1)!;
    return { failed: last.isFailure, result: last.result as Record<string, unknown> };
  }).pipe(Effect.provideService(McpCaller, caller), Effect.provide(TodoTools.handlers));

describe("to-do lists", () => {
  it("reorders listed ids first and keeps the rest in place", () => {
    const items = ["a", "b", "c", "d"].map((id) => ({ id }));
    expect(reordered(items, ["c", "x", "a"]).map((i) => i.id)).toEqual(["c", "a", "b", "d"]);
    expect(reordered(items, []).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });

  it.live("let the user add, edit, check, reorder and remove, and stream each list whole", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { todos, bot, changes } = yield* setup(f.cwd);
      const session = bot.mainSessionId;
      const first = yield* todos.add(session, "  Write the   migration ");
      expect(first.text).toBe("Write the migration");
      expect(first.addedBy).toBe("user");
      const second = yield* todos.add(session, "Add tests");
      const third = yield* todos.add(session, "Plan", 0);
      expect((yield* todos.list(session, "user")).items.map((i) => i.text)).toEqual(["Plan", "Write the migration", "Add tests"]);

      expect((yield* todos.update(first.id, { done: true })).done).toBe(true);
      expect((yield* todos.update(second.id, { text: "Add server tests" })).text).toBe("Add server tests");
      const order = yield* todos.reorder(session, [second.id]);
      expect(order.items.map((i) => i.id)).toEqual([second.id, third.id, first.id]);
      const cleared = yield* todos.clearDone(session);
      expect(cleared.items.map((i) => i.id)).toEqual([second.id, third.id]);
      yield* todos.remove(third.id);

      expect((yield* Effect.flip(todos.add(session, "   "))).code).toBe("invalid");
      expect((yield* Effect.flip(todos.update("todo_missing", { done: true }))).code).toBe("not_found");

      yield* until(() => changes.length >= 8);
      expect(changes[0]).toEqual({ _tag: "TodosSnapshot", lists: [] });
      const last = changes.at(-1)!;
      expect(last._tag === "TodoListChanged" && last.list.items.map((i) => i.text)).toEqual(["Add server tests"]);

      // A later watcher starts from every list.
      const snapshot = yield* Stream.runHead(todos.watch);
      expect(snapshot._tag === "Some" && snapshot.value._tag === "TodosSnapshot" && snapshot.value.lists.map((l) => l.items.length)).toEqual([1]);
    }).pipe(Effect.provide(f.layer()));
  });

  it.live("tell the agent what the user changed, once, on its next message", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, todos, bot } = yield* setup(f.cwd);
      const session = bot.mainSessionId;
      const caller = { sessionId: session, botId: bot.id, role: "main" as const };
      const planned = yield* call(caller, "apollo_todo_update", { add: [{ text: "Read the code" }, { text: "Ship it" }] });
      expect(planned.failed).toBe(false);
      expect(planned.result.open).toBe(2);
      const [read] = (yield* todos.list(session, "user")).items;

      // The agent's own changes are not news to it.
      yield* manager.send(session, "hello");
      yield* until(() => f.sent.length === 1);
      expect(f.sent[0]).toBe("hello");

      yield* todos.update(read!.id, { done: true });
      yield* todos.add(session, "Write docs");
      yield* manager.send(session, "how is it going?");
      yield* until(() => f.sent.length === 2);
      expect(f.sent[1]).toContain('[Apollo] The user changed your to-do list: checked off "Read the code"; added "Write docs".');
      expect(f.sent[1]).toContain("1. [x] Read the code");
      expect(f.sent[1]).toContain("3. [ ] Write docs");
      expect(f.sent[1]).toContain("added by the user");

      yield* manager.send(session, "again");
      yield* until(() => f.sent.length === 3);
      expect(f.sent[2]).toBe("again");

      // Reading the list in the meantime counts as seeing the change.
      yield* todos.add(session, "Celebrate");
      expect(((yield* call(caller, "apollo_todo_list", {})).result.list as string)).toContain("Celebrate");
      yield* manager.send(session, "and now?");
      yield* until(() => f.sent.length === 4);
      expect(f.sent[3]).toBe("and now?");
    }).pipe(Effect.provide(f.layer()));
  });

  it.live("keep the user's changes for the agent across a restart", () => {
    const f = fixture({ persistent: true });
    return Effect.gen(function* () {
      const { session, botId } = yield* Effect.gen(function* () {
        const { todos, bot } = yield* setup(f.cwd);
        const caller = { sessionId: bot.mainSessionId, botId: bot.id, role: "main" as const };
        yield* call(caller, "apollo_todo_update", { add: [{ text: "Plan" }, { text: "Build" }] });
        const [, build] = (yield* todos.list(bot.mainSessionId, "user")).items;
        yield* todos.add(bot.mainSessionId, "Test on the phone");
        yield* todos.reorder(bot.mainSessionId, [build!.id]);
        return { session: bot.mainSessionId, botId: bot.id };
      }).pipe(Effect.provide(f.layer()));

      // Apollo restarted: a new server over the same database.
      yield* Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        expect((yield* manager.snapshot).bots.map((b) => b.id)).toEqual([botId]);
        yield* manager.send(session, "where are we?");
        yield* until(() => f.sent.length === 1);
        expect(f.sent[0]).toContain('[Apollo] The user changed your to-do list: added "Test on the phone"; reordered the list.');
        expect(f.sent[0]).toContain("1. [ ] Build");
        expect(f.sent[0]).toContain("3. [ ] Test on the phone");
      }).pipe(Effect.provide(f.layer()));
    });
  });

  it.live("keep the user's changes for the agent until a message reaches it", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, todos, bot } = yield* setup(f.cwd);
      const session = bot.mainSessionId;
      yield* todos.add(session, "Write the release notes");

      f.failures.count = 1;
      expect((yield* Effect.flip(manager.send(session, "first try"))).code).toBe("provider");
      expect(f.sent).toEqual([]);

      yield* manager.send(session, "second try");
      yield* until(() => f.sent.length === 1);
      expect(f.sent[0]).toContain('[Apollo] The user changed your to-do list: added "Write the release notes".');

      yield* manager.send(session, "third");
      yield* until(() => f.sent.length === 2);
      expect(f.sent[1]).toBe("third");

      // An edit made while a message is on its way is not in it: it waits for the next one.
      f.failures.during = todos.add(session, "Tag the release");
      yield* todos.add(session, "Bump the version");
      yield* manager.send(session, "fourth");
      yield* until(() => f.sent.length === 3);
      delete f.failures.during;
      expect(f.sent[2]).toContain('added "Bump the version".');
      expect(f.sent[2]).not.toContain("Tag the release");
      yield* manager.send(session, "fifth");
      yield* until(() => f.sent.length === 4);
      expect(f.sent[3]).toContain('[Apollo] The user changed your to-do list: added "Tag the release".');
    }).pipe(Effect.provide(f.layer()));
  });

  it.live("apply an agent's changes together, or none when one is wrong", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { todos, bot } = yield* setup(f.cwd);
      const caller = { sessionId: bot.mainSessionId, botId: bot.id, role: "main" as const };
      yield* call(caller, "apollo_todo_update", { add: [{ text: "One" }, { text: "Two" }] });
      const [one, two] = (yield* todos.list(bot.mainSessionId, "agent")).items;

      const bad = yield* call(caller, "apollo_todo_update", { check: [one!.id], remove: ["todo_nope"] });
      expect(bad.failed).toBe(true);
      expect((yield* todos.list(bot.mainSessionId, "agent")).items.every((i) => !i.done)).toBe(true);

      const done = yield* call(caller, "apollo_todo_update", {
        check: [one!.id],
        edit: [{ id: two!.id, text: "Two, edited" }],
        order: [two!.id],
        add: [{ text: "Zero", index: 0 }],
      });
      expect(done.result.list).toBe(
        [`1. [ ] Zero (id: ${(yield* todos.list(bot.mainSessionId, "agent")).items[0]!.id})`, `2. [ ] Two, edited (id: ${two!.id})`, `3. [x] One (id: ${one!.id})`].join("\n"),
      );

      // Another session's items are out of reach.
      const worker = yield* SessionManager.SessionManager.pipe(
        Effect.flatMap((m) => m.createSession({ botId: bot.id, title: "w", provider: { provider: "codex" } })),
      );
      const other = yield* call({ sessionId: worker.id, botId: bot.id, role: "worker" }, "apollo_todo_update", { check: [one!.id] });
      expect(other.failed).toBe(true);
    }).pipe(Effect.provide(f.layer()));
  });
});
