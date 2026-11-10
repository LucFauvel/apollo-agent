import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ApolloError, type BotId, type Monitor, type SessionId } from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";

const MAX_RUNNING_PER_SESSION = 4;
/** Ended monitors kept per session, so the user can see how the last ones ended. */
const KEEP_ENDED_PER_SESSION = 5;
/** Lines printed close together reach the agent as one message. */
const BATCH_MS = 1000;
const MAX_LINES_PER_MESSAGE = 50;
const MAX_LINE_CHARS = 1000;
/** Stderr lines kept, to explain how a monitor ended. */
const STDERR_TAIL = 20;
export const DEFAULT_TIMEOUT_MINUTES = 60;
export const MAX_TIMEOUT_MINUTES = 24 * 60;

export interface MonitorCaller {
  readonly botId: BotId;
  readonly sessionId: SessionId;
}

export interface StartMonitor {
  readonly command: string;
  readonly description: string;
  readonly cwd?: string | undefined;
  /** Stops it after this long; null: runs until it exits or is stopped. */
  readonly timeoutMs: number | null;
}

interface Entry {
  monitor: Monitor;
  readonly process: ChildProcess;
  readonly exited: Deferred.Deferred<void>;
  pending: Array<string>;
  dropped: number;
  partial: string;
  stderr: Array<string>;
  stderrPartial: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  /** Deliveries to the session, one after the other so they arrive in order. */
  chain: Promise<void>;
  /** Set once someone stops it, so its exit reads as stopped rather than exited. */
  stopping: { readonly by: "agent" | "user" | "timeout" | "silent" } | null;
}

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

const clip = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);

const minutes = (ms: number) => {
  const m = ms / 60_000;
  return m >= 1 ? `${Math.round(m)} minute${Math.round(m) === 1 ? "" : "s"}` : `${Math.round(ms / 1000)} seconds`;
};

/**
 * Monitors: commands an agent watches. Each line a monitor prints on stdout is delivered to
 * its session as a message (lines close together arrive as one), so the agent reacts to
 * events (a log line, a CI status change, a file appearing) without polling. A monitor ends
 * when its command exits, its time is up, or the agent or the user stops it; the agent is
 * told how it ended, unless it stopped it itself.
 */
const make = Effect.gen(function* () {
  const store = yield* Store;
  const manager = yield* SessionManager;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const entries = new Map<string, Entry>();

  const publish = (entry: Entry) => manager.publish({ _tag: "MonitorUpserted", monitor: entry.monitor });

  const label = (m: Monitor) => `Monitor ${m.id} (${JSON.stringify(m.description)})`;

  /** Sends `text` to the monitor's session after whatever it sent before. */
  const deliver = (entry: Entry, text: string) => {
    const { sessionId, id } = entry.monitor;
    entry.chain = entry.chain.then(() =>
      runPromise(
        manager.send(sessionId, text, "system").pipe(
          Effect.catch((error) => Effect.logWarning(`could not deliver monitor ${id}'s events`, error)),
        ),
      ).catch(() => undefined),
    );
    return entry.chain;
  };

  /** The lines waiting to be delivered, as the body of a message (empty when none). */
  const takePending = (entry: Entry) => {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
    const lines = entry.pending;
    const dropped = entry.dropped;
    entry.pending = [];
    entry.dropped = 0;
    if (lines.length === 0) return "";
    const last = lines.at(-1)!;
    entry.monitor = {
      ...entry.monitor,
      events: entry.monitor.events + lines.length + dropped,
      lastEvent: last,
      lastEventAt: Date.now(),
    };
    return [...(dropped > 0 ? [`(${dropped} earlier lines skipped)`] : []), ...lines].join("\n");
  };

  const flush = (entry: Entry) => {
    const body = takePending(entry);
    if (!body || entry.stopping) return;
    runFork(publish(entry));
    void deliver(entry, `[Apollo] ${label(entry.monitor)}:\n${body}`);
  };

  const onLine = (entry: Entry, line: string) => {
    if (entry.stopping || !line.trim()) return;
    entry.pending.push(clip(line));
    if (entry.pending.length > MAX_LINES_PER_MESSAGE) {
      entry.pending.shift();
      entry.dropped++;
    }
    entry.flushTimer ??= setTimeout(() => flush(entry), BATCH_MS);
  };

  const split = (buffered: string, chunk: Buffer) => {
    const lines = (buffered + chunk.toString("utf8")).split(/\r?\n/);
    return { lines, rest: lines.pop() ?? "" };
  };

  /** Forgets the oldest ended monitors of a session beyond those kept. */
  const prune = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const ended = [...entries.values()]
        .filter((e) => e.monitor.sessionId === sessionId && e.monitor.status !== "running")
        .sort((a, b) => (b.monitor.endedAt ?? 0) - (a.monitor.endedAt ?? 0));
      for (const entry of ended.slice(KEEP_ENDED_PER_SESSION)) {
        entries.delete(entry.monitor.id);
        yield* manager.publish({ _tag: "MonitorRemoved", monitorId: entry.monitor.id, sessionId });
      }
    });

  const finish = (entry: Entry, code: number | null) => {
    if (entry.monitor.status !== "running") return;
    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
    if (entry.partial) onLine(entry, entry.partial);
    entry.partial = "";
    const stopping = entry.stopping;
    // Lines printed before it was stopped still reach the agent (unless it stopped it itself).
    const body = takePending(entry);
    const m = entry.monitor;
    const ran = minutes(Date.now() - m.startedAt);
    entry.monitor = {
      ...m,
      status: stopping === null ? "exited" : stopping.by === "timeout" ? "timed_out" : "stopped",
      stoppedBy: stopping?.by === "agent" || stopping?.by === "user" ? stopping.by : null,
      endedAt: Date.now(),
      exitCode: stopping === null ? code : null,
    };
    // Whoever stops it learns it ended once the UI was told.
    runFork(publish(entry).pipe(Effect.andThen(prune(m.sessionId)), Effect.ensuring(Deferred.succeed(entry.exited, undefined))));
    if (stopping?.by === "agent" || stopping?.by === "silent") return;
    const stderr = [...entry.stderr, ...(entry.stderrPartial ? [entry.stderrPartial] : [])].slice(-STDERR_TAIL);
    const text = [
      ...(body ? [`[Apollo] ${label(m)}:`, body, ""] : []),
      ...(stopping?.by === "user"
        ? [`[Apollo] The user stopped ${label(m)} after ${ran}.`, "Don't start it again unless they ask you to."]
        : stopping?.by === "timeout"
          ? [
              `[Apollo] ${label(m)} timed out after ${ran} and was stopped.`,
              "Start it again (with a longer timeoutMinutes, or persistent: true) if you still need it.",
            ]
          : [
              `[Apollo] ${label(m)} ended after ${ran}: exit code ${code ?? "unknown"}.`,
              ...(stderr.length > 0 ? ["Its last stderr output:", ...stderr] : []),
            ]),
    ];
    void deliver(entry, text.join("\n"));
  };

  const kill = (entry: Entry, signal: NodeJS.Signals) => {
    const pid = entry.process.pid;
    if (entry.monitor.status !== "running" || pid === undefined) return;
    try {
      if (process.platform === "win32") entry.process.kill(signal);
      else process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };

  /** Stops the monitor's process group (TERM, then KILL) and waits until it has ended. */
  const halt = (entry: Entry, by: NonNullable<Entry["stopping"]>["by"]) =>
    Effect.gen(function* () {
      if (entry.monitor.status !== "running") return;
      entry.stopping ??= { by };
      kill(entry, "SIGTERM");
      const done = yield* Deferred.await(entry.exited).pipe(Effect.timeoutOption("5 seconds"));
      if (Option.isNone(done)) {
        kill(entry, "SIGKILL");
        const killed = yield* Deferred.await(entry.exited).pipe(Effect.timeoutOption("2 seconds"));
        // Its pipes may stay open after it died (a grandchild holding them): count it as ended.
        if (Option.isNone(killed)) finish(entry, null);
      }
    });

  const own = (caller: MonitorCaller, monitorId: string) => {
    const entry = entries.get(monitorId);
    if (!entry || entry.monitor.botId !== caller.botId) return Effect.fail(invalid(`no monitor ${monitorId}`));
    return Effect.succeed(entry);
  };

  const start = (caller: MonitorCaller, input: StartMonitor) =>
    Effect.gen(function* () {
      if (!input.command.trim()) return yield* invalid("`command` is empty");
      const description = input.description.trim();
      if (!description) return yield* invalid("`description` is empty: say what it watches for");
      const running = [...entries.values()].filter((e) => e.monitor.sessionId === caller.sessionId && e.monitor.status === "running");
      if (running.length >= MAX_RUNNING_PER_SESSION) {
        return yield* invalid(`${running.length} monitors are already running in this session; stop one first`);
      }
      const session = yield* store.getSession(caller.sessionId);
      if (session.botId !== caller.botId) return yield* invalid("that session belongs to another bot");
      const cwd = input.cwd?.trim() || session.cwd;
      const id = `mon_${randomBytes(4).toString("hex")}`;
      const shell = process.env.SHELL || "/bin/sh";
      // Its own process group, so stopping it also stops what it started.
      const child = spawn(shell, ["-lc", input.command], {
        cwd,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const now = Date.now();
      const entry: Entry = {
        monitor: {
          id,
          botId: caller.botId,
          sessionId: caller.sessionId,
          description,
          command: input.command,
          cwd,
          status: "running",
          stoppedBy: null,
          startedAt: now,
          endedAt: null,
          deadline: input.timeoutMs === null ? null : now + input.timeoutMs,
          events: 0,
          lastEvent: null,
          lastEventAt: null,
          exitCode: null,
        },
        process: child,
        exited: yield* Deferred.make<void>(),
        pending: [],
        dropped: 0,
        partial: "",
        stderr: [],
        stderrPartial: "",
        flushTimer: null,
        deadlineTimer: null,
        chain: Promise.resolve(),
        stopping: null,
      };
      entries.set(id, entry);
      child.stdout?.on("data", (chunk: Buffer) => {
        const { lines, rest } = split(entry.partial, chunk);
        entry.partial = rest;
        for (const line of lines) onLine(entry, line);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const { lines, rest } = split(entry.stderrPartial, chunk);
        entry.stderrPartial = rest;
        entry.stderr.push(...lines.filter((l) => l.trim()).map(clip));
        if (entry.stderr.length > STDERR_TAIL) entry.stderr = entry.stderr.slice(-STDERR_TAIL);
      });
      // "close": after its output is read to the end, so the last lines are delivered.
      child.on("close", (code) => finish(entry, code));
      child.on("error", (error) => {
        entry.stderr.push(error.message);
        finish(entry, 127);
      });
      if (input.timeoutMs !== null) {
        entry.deadlineTimer = setTimeout(() => runFork(halt(entry, "timeout")), input.timeoutMs);
      }
      yield* publish(entry);
      return entry.monitor;
    });

  /** Stops, without telling anyone, every monitor matching `test`, and forgets them. */
  const dropWhere = (test: (m: Monitor) => boolean) =>
    Effect.gen(function* () {
      const matching = [...entries.values()].filter((e) => test(e.monitor));
      yield* Effect.forEach(matching, (entry) => halt(entry, "silent"), { concurrency: "unbounded", discard: true });
      for (const entry of matching) {
        entries.delete(entry.monitor.id);
        yield* manager.publish({ _tag: "MonitorRemoved", monitorId: entry.monitor.id, sessionId: entry.monitor.sessionId });
      }
    });

  yield* manager.onBotDeleted("monitors", (botId) => dropWhere((m) => m.botId === botId));
  yield* manager.changes.pipe(
    Stream.runForEach((change) =>
      change._tag === "SessionDeleted" ? dropWhere((m) => m.sessionId === change.sessionId) : Effect.void,
    ),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const entry of entries.values()) {
        entry.stopping ??= { by: "silent" };
        kill(entry, "SIGTERM");
      }
    }),
  );

  return {
    start,
    /** The agent stops one of its monitors; it is not messaged about it. */
    stop: (caller: MonitorCaller, monitorId: string) =>
      Effect.gen(function* () {
        const entry = yield* own(caller, monitorId);
        yield* halt(entry, "agent");
        return entry.monitor;
      }),
    /** The user stops a monitor from the UI; its agent is told. */
    stopByUser: (monitorId: string) =>
      Effect.gen(function* () {
        const entry = entries.get(monitorId);
        if (!entry) return yield* new ApolloError({ code: "not_found", message: `no monitor ${monitorId}` });
        yield* halt(entry, "user");
      }),
    /** The caller session's monitors, running and recently ended. */
    listFor: (caller: MonitorCaller) =>
      Effect.sync(() => [...entries.values()].map((e) => e.monitor).filter((m) => m.sessionId === caller.sessionId)),
    list: Effect.sync(() => [...entries.values()].map((e) => e.monitor)),
    /** Resolves once every delivery queued so far has been sent (for tests). */
    settled: Effect.promise(() => Promise.all([...entries.values()].map((e) => e.chain))).pipe(Effect.asVoid),
  };
});

export class Monitors extends Context.Service<Monitors, Effect.Success<typeof make>>()("apollo/Monitors") {}

export const layer = Layer.effect(Monitors, make);
