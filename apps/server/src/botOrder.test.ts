import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppChange, BotId, ProviderKind } from "@apollo/contracts";
import { ProviderKind as Kinds, sortBots } from "@apollo/contracts";
import type { Provider } from "@apollo/providers";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AppSettings from "./AppSettings.ts";
import { ServerConfig } from "./Config.ts";
import * as Database from "./Database.ts";
import * as SessionManager from "./SessionManager.ts";
import * as Store from "./Store.ts";

const idle = (kind: ProviderKind): Provider => ({ kind, listModels: Effect.succeed([]), open: () => Effect.die("not used") });

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "apollo-bot-order-"));
  const cwd = join(dir, "workspace");
  mkdirSync(cwd);
  const layer = SessionManager.layer.pipe(
    Layer.provideMerge(Layer.succeed(SessionManager.Providers, Object.fromEntries(Kinds.literals.map((k) => [k, idle(k)])) as Record<ProviderKind, Provider>)),
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
  return { cwd, layer };
};

type Manager = SessionManager.SessionManager["Service"];

const createBot = (manager: Manager, name: string, cwd: string) =>
  manager.createBot({
    name,
    instructions: "",
    cwd,
    main: { provider: "claude" },
    defaultWorker: { provider: "codex" },
    runtimeMode: "full-access",
    autoLearn: false,
  });

const names = (store: Store.Store["Service"]) => Effect.map(store.listBots, (bots) => bots.map((b) => b.name));

const collect = (manager: Manager) =>
  Effect.gen(function* () {
    const seen: Array<AppChange> = [];
    yield* Stream.runForEach(manager.changes, (change) => Effect.sync(() => void seen.push(change))).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    return seen;
  });

describe("bot order", () => {
  it("the migration keeps existing bots in the order they were shown (creation order)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "apollo-bot-order-db-")), "apollo.db");
    // The database as it was just before the bot-order migration (later ones may follow it).
    const before = Database.MIGRATIONS.findIndex((m) => m.includes("add column position"));
    expect(before).toBeGreaterThan(0);
    const db = new DatabaseSync(path);
    for (let v = 0; v < before; v++) db.exec(Database.MIGRATIONS[v]!);
    db.exec(`pragma user_version = ${before}`);
    const insert = db.prepare(
      `insert into bots (id, name, instructions, cwd, main_provider, worker_provider, runtime_mode, auto_learn,
         main_session_id, created_at, updated_at) values (?, ?, '', '/tmp', 'claude', 'codex', 'full-access', 0, ?, ?, ?)`,
    );
    // Inserted out of creation order, with a tie on created_at broken by id.
    insert.run("bot-c", "Ceres", "s-c", 300, 300);
    insert.run("bot-a", "Atlas", "s-a", 100, 100);
    insert.run("bot-b2", "Io", "s-b2", 200, 200);
    insert.run("bot-b1", "Nebula", "s-b1", 200, 200);
    db.close();

    const migrated = Database.open(path);
    const rows = migrated.prepare("select name, position from bots order by position").all();
    migrated.close();
    expect(rows).toEqual([
      { name: "Atlas", position: 0 },
      { name: "Nebula", position: 1 },
      { name: "Io", position: 2 },
      { name: "Ceres", position: 3 },
    ]);
  });

  it.live("new bots go last, a reorder is saved and pushed, and deleting a bot leaves a usable order", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const a = yield* createBot(manager, "A", f.cwd);
      const b = yield* createBot(manager, "B", f.cwd);
      const c = yield* createBot(manager, "C", f.cwd);
      expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);
      expect(yield* names(store)).toEqual(["A", "B", "C"]);

      const seen = yield* collect(manager);
      const result = yield* manager.reorderBots([c.id, a.id, b.id]);
      expect(result.map((bot) => bot.name)).toEqual(["C", "A", "B"]);
      expect(yield* names(store)).toEqual(["C", "A", "B"]);
      // Every moved bot is pushed with its new position, so other clients follow.
      yield* Effect.sleep("20 millis");
      const pushed = seen.flatMap((change) => (change._tag === "BotUpserted" ? [change.bot] : []));
      expect(pushed.map((bot) => [bot.name, bot.position]).sort()).toEqual([
        ["A", 1],
        ["B", 2],
        ["C", 0],
      ]);

      // A no-op reorder pushes nothing.
      seen.length = 0;
      yield* manager.reorderBots([c.id, a.id, b.id]);
      yield* Effect.sleep("20 millis");
      expect(seen.filter((change) => change._tag === "BotUpserted")).toEqual([]);

      // Editing a bot keeps its place.
      const renamed = yield* manager.updateBot({ botId: a.id, name: "A2" });
      expect(renamed.position).toBe(1);
      expect(yield* names(store)).toEqual(["C", "A2", "B"]);

      // A new bot goes last; a deleted one leaves a gap that sorting and the next reorder absorb.
      const d = yield* createBot(manager, "D", f.cwd);
      expect(d.position).toBe(3);
      yield* manager.deleteBot(a.id);
      expect(yield* names(store)).toEqual(["C", "B", "D"]);
      expect(sortBots(yield* store.listBots).map((bot) => bot.name)).toEqual(["C", "B", "D"]);
      const e = yield* createBot(manager, "E", f.cwd);
      expect(e.position).toBe(4);
      yield* manager.reorderBots([e.id, d.id, b.id, c.id]);
      expect((yield* store.listBots).map((bot) => [bot.name, bot.position])).toEqual([
        ["E", 0],
        ["D", 1],
        ["B", 2],
        ["C", 3],
      ]);
    }).pipe(Effect.provide(f.layer));
  });

  it.live("a reorder racing a create or delete still applies: unknown ids are skipped, missing bots follow", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      yield* createBot(manager, "A", f.cwd);
      const b = yield* createBot(manager, "B", f.cwd);
      const c = yield* createBot(manager, "C", f.cwd);
      yield* createBot(manager, "D", f.cwd);
      // The client did not know about D yet, and still listed a bot deleted meanwhile.
      yield* manager.reorderBots(["bot-gone" as BotId, c.id, b.id]);
      expect(yield* names(store)).toEqual(["C", "B", "A", "D"]);
      // An empty list changes nothing.
      yield* manager.reorderBots([]);
      expect(yield* names(store)).toEqual(["C", "B", "A", "D"]);
    }).pipe(Effect.provide(f.layer));
  });

  it.live("an id listed twice is rejected and the order is unchanged", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const a = yield* createBot(manager, "A", f.cwd);
      const b = yield* createBot(manager, "B", f.cwd);
      const failed = yield* Effect.exit(manager.reorderBots([b.id, a.id, b.id]));
      expect(Exit.isFailure(failed)).toBe(true);
      expect(Exit.findErrorOption(failed)).toMatchObject({ _tag: "Some", value: { _tag: "ApolloError", code: "invalid" } });
      expect(yield* names(store)).toEqual(["A", "B"]);
    }).pipe(Effect.provide(f.layer));
  });
});

describe("sortBots", () => {
  it("sorts by position, then creation, then id", () => {
    const bots = [
      { id: "c", position: 1, createdAt: 5 },
      { id: "b", position: 0, createdAt: 9 },
      { id: "a", position: 1, createdAt: 5 },
      { id: "d", position: 1, createdAt: 1 },
    ];
    expect(sortBots(bots).map((b) => b.id)).toEqual(["b", "d", "a", "c"]);
  });
});
