import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AppChange, Monitor, ProviderKind } from "@apollo/contracts";
import { ProviderKind as Kinds } from "@apollo/contracts";
import type { Provider } from "@apollo/providers";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AppSettings from "../AppSettings.ts";
import { ServerConfig } from "../Config.ts";
import * as Database from "../Database.ts";
import * as SessionManager from "../SessionManager.ts";
import * as Store from "../Store.ts";
import * as Monitors from "./Monitors.ts";

/** A provider that records every message it is sent and ends each turn at once. */
const recording = (kind: ProviderKind, sent: Array<string>): Provider => ({
  kind,
  listModels: Effect.succeed([]),
  open: (_options, emit) =>
    Effect.gen(function* () {
      const agent = (event: AgentEvent) => emit({ _tag: "Event", event });
      return {
        send: (text: string) =>
          Effect.gen(function* () {
            sent.push(text);
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
  const dir = mkdtempSync(join(tmpdir(), "apollo-monitors-"));
  const cwd = join(dir, "workspace");
  mkdirSync(cwd);
  const sent: Array<string> = [];
  const layer = Monitors.layer.pipe(
    Layer.provideMerge(SessionManager.layer),
    Layer.provideMerge(
      Layer.succeed(SessionManager.Providers, Object.fromEntries(Kinds.literals.map((k) => [k, recording(k, sent)])) as Record<ProviderKind, Provider>),
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
  return { dir, cwd, sent, layer };
};

const setup = (cwd: string) =>
  Effect.gen(function* () {
    const manager = yield* SessionManager.SessionManager;
    const monitors = yield* Monitors.Monitors;
    const changes: Array<AppChange> = [];
    yield* Stream.runForEach(manager.changes, (change) => Effect.sync(() => void changes.push(change))).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const bot = yield* manager.createBot({
      name: "Watcher",
      instructions: "",
      cwd,
      main: { provider: "claude" },
      defaultWorker: { provider: "codex" },
      runtimeMode: "full-access",
      autoLearn: false,
    });
    const caller = { botId: bot.id, sessionId: bot.mainSessionId };
    const upserts = (id: string) =>
      changes.flatMap((c): Array<Monitor> => (c._tag === "MonitorUpserted" && c.monitor.id === id ? [c.monitor] : []));
    return { manager, monitors, bot, caller, changes, upserts };
  });

const until = (test: () => boolean, ms = 8000) =>
  Effect.promise(async () => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      if (test()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  });

const node = (script: string) => `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

describe.skipIf(process.platform === "win32")("monitors", () => {
  it.live("delivers lines printed close together as one message, then how the command ended", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { monitors, caller, upserts } = yield* setup(f.cwd);
      const started = yield* monitors.start(caller, {
        command: node("console.log('build 1 failed'); console.log('build 2 passed'); console.error('oops'); process.exit(3)"),
        description: "CI builds",
        timeoutMs: null,
      });
      expect(started.status).toBe("running");
      expect(started.deadline).toBeNull();
      yield* until(() => f.sent.some((t) => t.includes("ended after")));
      yield* monitors.settled;
      const events = f.sent.filter((t) => t.includes(started.id));
      expect(events).toHaveLength(1);
      expect(events[0]).toContain(`[Apollo] Monitor ${started.id} ("CI builds"):\nbuild 1 failed\nbuild 2 passed`);
      expect(events[0]).toContain("exit code 3");
      expect(events[0]).toContain("Its last stderr output:\noops");
      yield* until(() => upserts(started.id).at(-1)?.status === "exited");
      const last = upserts(started.id).at(-1)!;
      expect(last).toMatchObject({ status: "exited", exitCode: 3, events: 2, lastEvent: "build 2 passed", stoppedBy: null });
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("batches a burst of lines and delivers later ones in a new message", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { monitors, caller } = yield* setup(f.cwd);
      const started = yield* monitors.start(caller, {
        command: node("console.log('first'); setTimeout(() => console.log('second'), 1800); setInterval(() => {}, 1000)"),
        description: "ticks",
        timeoutMs: null,
      });
      yield* until(() => f.sent.some((t) => t.endsWith("second")));
      const events = f.sent.filter((t) => t.includes(started.id));
      expect(events).toEqual([
        `[Apollo] Monitor ${started.id} ("ticks"):\nfirst`,
        `[Apollo] Monitor ${started.id} ("ticks"):\nsecond`,
      ]);
      yield* monitors.stop(caller, started.id);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("stopped by the user: its process group is killed and the agent is told not to restart it", () => {
    const f = fixture();
    const pidFile = join(f.dir, "child.pid");
    const child = join(f.dir, "child.cjs");
    writeFileSync(child, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    return Effect.gen(function* () {
      const { monitors, caller, upserts } = yield* setup(f.cwd);
      const started = yield* monitors.start(caller, {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(child)} & wait`,
        description: "a log",
        timeoutMs: 60_000,
      });
      expect(started.deadline).toBeGreaterThan(Date.now());
      yield* until(() => {
        try {
          return readFileSync(pidFile, "utf8").length > 0;
        } catch {
          return false;
        }
      });
      const pid = Number(readFileSync(pidFile, "utf8"));
      yield* monitors.stopByUser(started.id);
      yield* until(() => upserts(started.id).at(-1)?.status === "stopped");
      expect(upserts(started.id).at(-1)).toMatchObject({ status: "stopped", stoppedBy: "user" });
      yield* until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      yield* monitors.settled;
      expect(f.sent.find((t) => t.includes(started.id))).toMatch(/^\[Apollo\] The user stopped Monitor mon_\w+ \("a log"\) after \d+ seconds\.\nDon't start it again/);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("stopped by the agent: nothing is sent; another bot cannot stop it", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, monitors, caller, upserts } = yield* setup(f.cwd);
      const other = yield* manager.createBot({
        name: "Other",
        instructions: "",
        cwd: f.cwd,
        main: { provider: "claude" },
        defaultWorker: { provider: "codex" },
        runtimeMode: "full-access",
        autoLearn: false,
      });
      const started = yield* monitors.start(caller, { command: "sleep 30", description: "nothing", timeoutMs: null });
      const refused = yield* monitors.stop({ botId: other.id, sessionId: other.mainSessionId }, started.id).pipe(Effect.flip);
      expect(refused.message).toBe(`no monitor ${started.id}`);
      const stopped = yield* monitors.stop(caller, started.id);
      expect(stopped).toMatchObject({ status: "stopped", stoppedBy: "agent" });
      yield* until(() => upserts(started.id).at(-1)?.status === "stopped");
      yield* Effect.sleep("200 millis");
      yield* monitors.settled;
      expect(f.sent.filter((t) => t.includes(started.id))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("times out and tells the agent", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { monitors, caller, upserts } = yield* setup(f.cwd);
      const started = yield* monitors.start(caller, { command: "sleep 30", description: "slow", timeoutMs: 300 });
      yield* until(() => f.sent.some((t) => t.includes("timed out")));
      yield* until(() => upserts(started.id).at(-1)?.status === "timed_out");
      expect(upserts(started.id).at(-1)).toMatchObject({ status: "timed_out", stoppedBy: null });
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("refuses an empty command or description, and more than 4 running in a session", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { monitors, caller } = yield* setup(f.cwd);
      expect((yield* monitors.start(caller, { command: " ", description: "x", timeoutMs: null }).pipe(Effect.flip)).message).toBe("`command` is empty");
      expect((yield* monitors.start(caller, { command: "true", description: "", timeoutMs: null }).pipe(Effect.flip)).message).toContain("`description` is empty");
      for (let i = 0; i < 4; i++) yield* monitors.start(caller, { command: "sleep 30", description: `m${i}`, timeoutMs: null });
      const refused = yield* monitors.start(caller, { command: "sleep 30", description: "one more", timeoutMs: null }).pipe(Effect.flip);
      expect(refused.message).toContain("4 monitors are already running");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("deleting the bot stops and forgets its monitors without messaging", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, monitors, bot, caller, changes } = yield* setup(f.cwd);
      const started = yield* monitors.start(caller, { command: "sleep 30", description: "gone", timeoutMs: null });
      yield* manager.deleteBot(bot.id);
      expect(yield* monitors.list).toEqual([]);
      expect(changes.some((c) => c._tag === "MonitorRemoved" && c.monitorId === started.id)).toBe(true);
      expect(f.sent.filter((t) => t.includes(started.id))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
