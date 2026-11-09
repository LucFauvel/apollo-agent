import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppChange, ProviderKind } from "@apollo/contracts";
import { ProviderKind as Kinds } from "@apollo/contracts";
import type { Provider } from "@apollo/providers";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AppSettings from "./AppSettings.ts";
import { saveAttachment } from "./attachments.ts";
import { ServerConfig } from "./Config.ts";
import * as Database from "./Database.ts";
import * as Jobs from "./jobs/Jobs.ts";
import * as SessionManager from "./SessionManager.ts";
import * as Store from "./Store.ts";

// Acceptance tests pinned from the round-1 adversarial review of bot deletion: each one
// reproduces a reviewer probe (probes/server.ts, race-real.ts, post-row-real.ts).

const idle = (kind: ProviderKind): Provider => ({ kind, listModels: Effect.succeed([]), open: () => Effect.die("not used") });

const fixture = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `apollo-delete-${name}-`));
  const cwd = join(dir, "workspace");
  mkdirSync(cwd);
  const layer = Jobs.layer.pipe(
    Layer.provideMerge(SessionManager.layer),
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
  return { dir, cwd, layer };
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

const collect = (manager: Manager) =>
  Effect.gen(function* () {
    const seen: Array<AppChange> = [];
    yield* Stream.runForEach(manager.changes, (change) => Effect.sync(() => void seen.push(change))).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    return seen;
  });

const gitRepo = (cwd: string) => {
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "t@example.com");
  writeFileSync(join(cwd, "keep"), "keep");
  git("add", ".");
  git("commit", "-qm", "seed");
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = (test: () => boolean) =>
  Effect.promise(async () => {
    for (let n = 0; n < 500; n++) {
      if (test()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out");
  });

describe("deleting a bot (reviewer round 1)", () => {
  it.live.skipIf(process.platform === "win32")(
    "reviewer round 1 repro: no process descended from a deleted bot's job survives (SIGTERM-ignoring grandchild)",
    () => {
      const f = fixture("jobs");
      const child = join(f.dir, "child.cjs");
      const leader = join(f.dir, "leader.cjs");
      const pidFile = join(f.dir, "pid");
      writeFileSync(
        child,
        `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);`,
      );
      writeFileSync(leader, `require('node:child_process').spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{},1000);`);
      let pid = 0;
      return Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const jobs = yield* Jobs.Jobs;
        const bot = yield* createBot(manager, "Jobs", f.cwd);
        yield* jobs.start({ botId: bot.id, sessionId: bot.mainSessionId }, { command: `exec ${process.execPath} ${leader}` });
        yield* until(() => existsSync(pidFile));
        pid = Number(readFileSync(pidFile, "utf8"));
        expect(alive(pid)).toBe(true);
        yield* manager.deleteBot(bot.id);
        expect(alive(pid)).toBe(false);
      }).pipe(
        Effect.ensuring(Effect.sync(() => pid && alive(pid) && process.kill(pid, "SIGKILL"))),
        Effect.scoped,
        Effect.provide(f.layer),
      );
    },
    20_000,
  );

  it.live.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reviewer round 1 repro: a failed session teardown (unwritable attachment) keeps the bot, and a retry completes the deletion",
    () => {
      const f = fixture("attachment");
      let locked = "";
      return Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const store = yield* Store.Store;
        const bot = yield* createBot(manager, "Permissions", f.cwd);
        const worker = yield* manager.createSession({ botId: bot.id, title: "", provider: { provider: "codex" } });
        const ref = saveAttachment(f.dir, worker.id, "held", "text/plain", Buffer.from("owned"));
        locked = join(f.dir, "attachments", worker.id, ref.id);
        chmodSync(locked, 0o500);
        const seen = yield* collect(manager);

        const failed = yield* Effect.flip(manager.deleteBot(bot.id));
        // Nothing past the point of no return: the bot and the failed session are still there.
        expect(failed.code).toBe("internal");
        expect((yield* store.getBot(bot.id)).id).toBe(bot.id);
        expect((yield* store.getSession(worker.id)).id).toBe(worker.id);
        expect(yield* store.getSetting("sessions.untitled")).toContain(worker.id);
        expect(seen.some((c) => c._tag === "BotDeleted")).toBe(false);

        // Once the cause is fixed, deleting again finishes the job.
        chmodSync(locked, 0o700);
        yield* manager.deleteBot(bot.id);
        yield* Effect.yieldNow;
        expect(existsSync(join(f.dir, "attachments", worker.id))).toBe(false);
        expect(yield* store.getSetting("sessions.untitled")).toBeNull();
        expect(seen.some((c) => c._tag === "SessionDeleted" && c.sessionId === worker.id)).toBe(true);
        expect(seen.at(-1)).toEqual({ _tag: "BotDeleted", botId: bot.id });
        expect((yield* Effect.flip(store.getBot(bot.id))).code).toBe("not_found");
      }).pipe(
        Effect.ensuring(Effect.sync(() => locked && existsSync(locked) && chmodSync(locked, 0o700))),
        Effect.scoped,
        Effect.provide(f.layer),
      );
    },
  );

  it.live("reviewer round 1 repro: deleting a bot during a worktree session's creation leaves no checkout and no raw defect", () => {
    const f = fixture("race");
    gitRepo(f.cwd);
    return Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager, "Race", f.cwd);
      const creating = yield* manager
        .createSession({ botId: bot.id, title: "", provider: { provider: "codex" }, isolation: "worktree" })
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
      yield* manager.deleteBot(bot.id);
      // Once the delete returns, no checkout of the bot is left anywhere.
      const worktrees = join(f.dir, "worktrees");
      expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
      expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: f.cwd, encoding: "utf8" })).not.toContain(worktrees);
      expect(yield* store.listSessions(bot.id)).toEqual([]);
      // The creation either won the race (and its session was deleted with the bot) or failed cleanly.
      const result = yield* Fiber.join(creating);
      if (Exit.isFailure(result)) {
        expect(JSON.stringify(result)).not.toContain("SQLITE");
        expect(Exit.findErrorOption(result)._tag).toBe("Some");
      }
      expect(yield* store.getSetting("sessions.untitled")).toBeNull();
      // Nor does one appear later.
      expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
      expect(yield* store.listSessions(bot.id)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("reviewer round 1 repro: sessions created while a bot is being deleted fail cleanly and leave no attachments or untitled ids", () => {
    const f = fixture("creators");
    return Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager, "Racing workers", f.cwd);
      yield* manager.createSession({ botId: bot.id, title: "w", provider: { provider: "codex" } });
      // Every session removal is followed by a creator trying to add a worker (with a file).
      const original = store.deleteSession;
      const attempts: Array<Exit.Exit<unknown, { code: string }>> = [];
      (store as { deleteSession: typeof original }).deleteSession = (id) =>
        Effect.gen(function* () {
          yield* original(id);
          attempts.push(
            yield* manager.createSession({ botId: bot.id, title: "", provider: { provider: "codex" } }).pipe(
              Effect.tap((w) => Effect.sync(() => saveAttachment(f.dir, w.id, "owned", "text/plain", Buffer.from("owned")))),
              Effect.exit,
            ),
          );
        });
      yield* manager.deleteBot(bot.id).pipe(
        Effect.ensuring(Effect.sync(() => ((store as { deleteSession: typeof original }).deleteSession = original))),
      );
      expect(attempts.length).toBeGreaterThan(0);
      for (const attempt of attempts) {
        expect(Exit.isFailure(attempt)).toBe(true);
        if (Exit.isFailure(attempt)) expect(Exit.findErrorOption(attempt)).toMatchObject({ value: { code: "not_found" } });
      }
      expect(yield* store.listSessions(bot.id)).toEqual([]);
      expect(existsSync(join(f.dir, "attachments")) ? readdirSync(join(f.dir, "attachments")) : []).toEqual([]);
      expect(yield* store.getSetting("sessions.untitled")).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reviewer round 1 repro: an unwritable skills plugin dir never strands the deletion without BotDeleted",
    () => {
      const f = fixture("plugin");
      let plugin = "";
      return Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const store = yield* Store.Store;
        const bot = yield* createBot(manager, "PluginPermissions", f.cwd);
        plugin = join(f.dir, "skills", bot.id);
        mkdirSync(plugin, { recursive: true });
        writeFileSync(join(plugin, "owned"), "x");
        chmodSync(plugin, 0o500);
        const seen = yield* collect(manager);

        const first = yield* Effect.exit(manager.deleteBot(bot.id));
        yield* Effect.yieldNow;
        const deleted = seen.some((c) => c._tag === "BotDeleted");
        // Either the deletion completed (and said so), or the bot is still there to retry.
        if (Exit.isFailure(first)) {
          expect(deleted).toBe(false);
          expect((yield* store.getBot(bot.id)).id).toBe(bot.id);
          chmodSync(plugin, 0o700);
          yield* manager.deleteBot(bot.id);
          yield* Effect.yieldNow;
        }
        expect(seen.filter((c) => c._tag === "BotDeleted")).toEqual([{ _tag: "BotDeleted", botId: bot.id }]);
        expect((yield* Effect.flip(store.getBot(bot.id))).code).toBe("not_found");
        expect(existsSync(plugin)).toBe(false);
      }).pipe(
        Effect.ensuring(Effect.sync(() => plugin && existsSync(plugin) && chmodSync(plugin, 0o700))),
        Effect.scoped,
        Effect.provide(f.layer),
      );
    },
  );

  it.live("reviewer round 1 repro: a core-memory cleanup defect never strands the deletion without BotDeleted", () => {
    const f = fixture("core");
    return Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const bot = yield* createBot(manager, "LateFailure", f.cwd);
      yield* store.setCoreMemory(bot.id, "notes", ["leftover"]);
      const seen = yield* collect(manager);
      const original = store.deleteCoreMemoryScope;
      const patched = store as { deleteCoreMemoryScope: typeof original };
      patched.deleteCoreMemoryScope = () => Effect.die(new Error("injected SQL I/O failure"));
      const first = yield* Effect.exit(manager.deleteBot(bot.id)).pipe(Effect.ensuring(Effect.sync(() => (patched.deleteCoreMemoryScope = original))));
      yield* Effect.yieldNow;
      if (Exit.isFailure(first)) {
        // A clean, typed error, and the bot is still there to retry.
        expect(Exit.findErrorOption(first)._tag).toBe("Some");
        expect(seen.some((c) => c._tag === "BotDeleted")).toBe(false);
        expect((yield* store.getBot(bot.id)).id).toBe(bot.id);
        yield* manager.deleteBot(bot.id);
        yield* Effect.yieldNow;
      }
      expect(seen.filter((c) => c._tag === "BotDeleted")).toEqual([{ _tag: "BotDeleted", botId: bot.id }]);
      expect((yield* store.getCoreMemory(bot.id)).notes).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("a defect in a cleanup after the bot row is gone still publishes BotDeleted", () => {
    const f = fixture("post-row");
    return Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const bot = yield* createBot(manager, "Hooked", f.cwd);
      const seen = yield* collect(manager);
      yield* manager.onBotDeleted("throwing", () =>
        Effect.sync(() => {
          throw new Error("injected");
        }),
      );
      yield* manager.deleteBot(bot.id);
      yield* Effect.yieldNow;
      expect(seen.at(-1)).toEqual({ _tag: "BotDeleted", botId: bot.id });
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
