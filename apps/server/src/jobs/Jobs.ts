import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { ApolloError, type BotId, type SessionId } from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../Config.ts";
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";

/** Lines of output kept in memory per job (the full output is in its log file). */
const TAIL_LINES = 400;
const MAX_JOBS_PER_SESSION = 8;

interface Job {
  readonly id: string;
  readonly botId: BotId;
  readonly sessionId: SessionId;
  readonly command: string;
  readonly cwd: string;
  readonly logPath: string;
  readonly startedAt: number;
  readonly notify: boolean;
  /** Stopped because its bot was deleted: nobody is left to report to. */
  orphaned: boolean;
  readonly process: ChildProcess;
  readonly log: WriteStream;
  readonly exited: Deferred.Deferred<void>;
  tail: Array<string>;
  partial: string;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  waiters: number;
}

export interface JobCaller {
  readonly botId: BotId;
  readonly sessionId: SessionId;
}

export interface JobStatus {
  readonly jobId: string;
  readonly command: string;
  readonly cwd: string;
  readonly running: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly seconds: number;
  readonly logPath: string;
  readonly output: string;
}

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

/**
 * Long-running shell commands an agent starts and comes back to (dev servers,
 * builds, test suites), instead of polling them from its own shell. A job that
 * ends while nobody waits on it reports back to its session.
 */
const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const store = yield* Store;
  const manager = yield* SessionManager;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const dir = join(config.dataDir, "jobs");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const jobs = new Map<string, Job>();

  const status = (job: Job, lines = 60): JobStatus => {
    const tail = [...job.tail, ...(job.partial ? [job.partial] : [])].slice(-Math.min(Math.max(lines, 1), TAIL_LINES));
    let output = tail.join("\n");
    if (output.length > 16_000) output = `…${output.slice(-16_000)}`;
    return {
      jobId: job.id,
      command: job.command,
      cwd: job.cwd,
      running: job.endedAt === null,
      exitCode: job.exitCode,
      signal: job.signal,
      seconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
      logPath: job.logPath,
      output,
    };
  };

  const own = (caller: JobCaller, jobId: string) => {
    const job = jobs.get(jobId);
    if (!job || job.botId !== caller.botId) return Effect.fail(invalid(`no background job ${jobId}`));
    return Effect.succeed(job);
  };

  const onOutput = (job: Job, chunk: Buffer) => {
    job.log.write(chunk);
    const lines = (job.partial + chunk.toString("utf8")).split(/\r?\n/);
    job.partial = lines.pop() ?? "";
    job.tail.push(...lines);
    if (job.tail.length > TAIL_LINES) job.tail = job.tail.slice(-TAIL_LINES);
  };

  const report = (job: Job) =>
    Effect.gen(function* () {
      const s = status(job, 20);
      const outcome = s.signal ? `stopped (${s.signal})` : `exit code ${s.exitCode}`;
      const text = [
        `[Apollo] Background job ${job.id} finished: ${outcome} after ${s.seconds}s.`,
        `Command: ${job.command}`,
        s.output ? `Last output:\n${s.output}` : "It printed nothing.",
        `Full log: ${job.logPath}`,
      ].join("\n");
      yield* manager.send(job.sessionId, text, "system");
    }).pipe(Effect.catch((error) => Effect.logWarning(`could not report job ${job.id}`, error)));

  const start = (caller: JobCaller, input: { command: string; cwd?: string | undefined; notify?: boolean | undefined }) =>
    Effect.gen(function* () {
      if (!input.command.trim()) return yield* invalid("`command` is empty");
      const running = [...jobs.values()].filter((j) => j.sessionId === caller.sessionId && j.endedAt === null);
      if (running.length >= MAX_JOBS_PER_SESSION) {
        return yield* invalid(`${running.length} jobs are already running in this session; stop one first`);
      }
      const session = yield* store.getSession(caller.sessionId);
      const cwd = input.cwd?.trim() || session.cwd;
      const id = `job_${randomBytes(4).toString("hex")}`;
      const logPath = join(dir, `${id}.log`);
      const shell = process.env.SHELL || "/bin/sh";
      // Its own process group, so stopping it also stops what it started.
      const child = spawn(shell, ["-lc", input.command], {
        cwd,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const job: Job = {
        id,
        botId: caller.botId,
        sessionId: caller.sessionId,
        command: input.command,
        cwd,
        logPath,
        startedAt: Date.now(),
        notify: input.notify ?? true,
        orphaned: false,
        process: child,
        log: createWriteStream(logPath),
        exited: yield* Deferred.make<void>(),
        tail: [],
        partial: "",
        endedAt: null,
        exitCode: null,
        signal: null,
        waiters: 0,
      };
      jobs.set(id, job);
      child.stdout?.on("data", (chunk: Buffer) => onOutput(job, chunk));
      child.stderr?.on("data", (chunk: Buffer) => onOutput(job, chunk));
      const finish = (code: number | null, signal: string | null) => {
        if (job.endedAt !== null) return;
        job.endedAt = Date.now();
        job.exitCode = code;
        job.signal = signal;
        job.log.end();
        // Someone waiting on it gets the result directly; otherwise tell the session.
        // (Checked before releasing the waiters, which stop counting as they wake.)
        const waited = job.waiters > 0;
        runFork(Deferred.succeed(job.exited, undefined));
        if (job.notify && !waited && !job.orphaned) runFork(report(job));
      };
      child.on("exit", (code, signal) => finish(code, signal));
      child.on("error", (error) => {
        onOutput(job, Buffer.from(`${error.message}\n`));
        finish(127, null);
      });
      return status(job);
    });

  const kill = (job: Job, signal: NodeJS.Signals) => {
    if (job.endedAt !== null || job.process.pid === undefined) return;
    try {
      if (process.platform === "win32") job.process.kill(signal);
      else process.kill(-job.process.pid, signal);
    } catch {
      // Already gone.
    }
  };

  const stop = (caller: JobCaller, jobId: string) =>
    Effect.gen(function* () {
      const job = yield* own(caller, jobId);
      job.waiters++; // The caller learns the outcome from this call.
      kill(job, "SIGTERM");
      const done = yield* Deferred.await(job.exited).pipe(Effect.timeoutOption("5 seconds"));
      if (Option.isNone(done)) {
        kill(job, "SIGKILL");
        yield* Deferred.await(job.exited).pipe(Effect.timeoutOption("2 seconds"));
      }
      job.waiters--;
      return status(job);
    });

  /**
   * Whether anything of the job's process group still runs: the leader may be gone while
   * what it started lives on. (Windows has no process groups: the leader alone.)
   */
  const groupAlive = (job: Job) => {
    const pid = job.process.pid;
    if (pid === undefined) return false;
    if (process.platform === "win32") return job.endedAt === null;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const signalGroup = (job: Job, signal: NodeJS.Signals) => {
    const pid = job.process.pid;
    if (pid === undefined) return;
    try {
      if (process.platform === "win32") job.process.kill(signal);
      else process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  /** Polls until the job's whole process group is gone, or the time is up. */
  const groupGone = (job: Job, ms: number) =>
    Effect.gen(function* () {
      for (const end = Date.now() + ms; groupAlive(job) && Date.now() < end; ) yield* Effect.sleep("25 millis");
      return !groupAlive(job);
    });

  /**
   * Stops every job of a deleted bot, with everything each one started: SIGTERM to the
   * process group, then SIGKILL to whatever of it is left after a grace period (even when
   * the leader itself exited). None reports back to its (deleted) session; all are forgotten.
   */
  const stopForBot = (botId: BotId) =>
    Effect.gen(function* () {
      const owned = [...jobs.values()].filter((j) => j.botId === botId);
      for (const job of owned) {
        job.orphaned = true;
        if (groupAlive(job)) signalGroup(job, "SIGTERM");
      }
      yield* Effect.forEach(
        owned,
        (job) =>
          Effect.gen(function* () {
            if (yield* groupGone(job, 3000)) return;
            signalGroup(job, "SIGKILL");
            yield* groupGone(job, 2000);
          }),
        { concurrency: "unbounded", discard: true },
      );
      for (const job of owned) {
        jobs.delete(job.id);
        try {
          rmSync(job.logPath, { force: true });
        } catch {
          // Still held open (Windows): the folder is cleared on the next start.
        }
      }
    });
  yield* manager.onBotDeleted("background jobs", stopForBot);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const job of jobs.values()) kill(job, "SIGTERM");
    }),
  );

  return {
    start,
    stop,
    stopForBot,
    status: (caller: JobCaller, jobId: string, lines?: number) => Effect.map(own(caller, jobId), (job) => status(job, lines)),
    /** Waits until the job ends or the timeout passes, then returns its status. */
    wait: (caller: JobCaller, jobId: string, timeoutSeconds: number, lines?: number) =>
      Effect.gen(function* () {
        const job = yield* own(caller, jobId);
        job.waiters++;
        yield* Deferred.await(job.exited).pipe(
          Effect.timeoutOption(`${Math.min(Math.max(timeoutSeconds, 1), 600)} seconds`),
          Effect.ensuring(Effect.sync(() => job.waiters--)),
        );
        return { ...status(job, lines), timedOut: job.endedAt === null };
      }),
    list: (caller: JobCaller) =>
      Effect.sync(() =>
        [...jobs.values()]
          .filter((j) => j.sessionId === caller.sessionId)
          .map((j) => {
            const { output: _output, ...rest } = status(j, 0);
            return rest;
          }),
      ),
  };
});

export class Jobs extends Context.Service<Jobs, Effect.Success<typeof make>>()("apollo/Jobs") {}

export const layer = Layer.effect(Jobs, make);
