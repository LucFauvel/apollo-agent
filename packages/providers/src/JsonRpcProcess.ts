import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio, as spoken by
 * `codex app-server`. The process lives exactly as long as the enclosing scope.
 */
export interface JsonRpcProcess {
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, JsonRpcFailure>;
  readonly notify: (method: string, params: unknown) => Effect.Effect<void>;
}

export class JsonRpcFailure extends Schema.TaggedError<JsonRpcFailure>()("JsonRpcFailure", {
  message: Schema.String,
  /** The JSON-RPC error code, when the other side answered with an error. */
  code: Schema.optional(Schema.Number),
}) {}

export interface JsonRpcHandlers {
  readonly onNotification: (method: string, params: unknown) => Effect.Effect<void>;
  /** Answers a request initiated by the child. Fail to return a JSON-RPC error. */
  readonly onRequest: (method: string, params: unknown) => Effect.Effect<unknown, JsonRpcFailure>;
  readonly onExit: (reason: string) => Effect.Effect<void>;
  readonly onStderr?: (line: string) => Effect.Effect<void>;
  /** Lines on stdout that are not JSON (some agents print sign-in links there). */
  readonly onStdoutText?: (line: string) => Effect.Effect<void>;
}

type RequestId = string | number;
interface IncomingMessage {
  readonly id?: RequestId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

export const spawnJsonRpcProcess = (options: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly handlers: JsonRpcHandlers;
}): Effect.Effect<JsonRpcProcess, JsonRpcFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const run = Effect.runForkWith(context);
    const { handlers } = options;

    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn(options.command, [...options.args], {
            cwd: options.cwd,
            env: options.env ?? process.env,
            stdio: ["pipe", "pipe", "pipe"],
          }),
        catch: (cause) => new JsonRpcFailure({ message: `failed to spawn ${options.command}: ${String(cause)}` }),
      }),
      (child) =>
        Effect.sync(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        }),
    );

    const pending = new Map<RequestId, Deferred.Deferred<unknown, JsonRpcFailure>>();
    let nextId = 1;
    let exited = false;

    const write = (message: object) =>
      Effect.sync(() => {
        if (!exited) child.stdin.write(`${JSON.stringify(message)}\n`);
      });

    const failAllPending = (reason: string) => {
      for (const deferred of pending.values()) run(Deferred.fail(deferred, new JsonRpcFailure({ message: reason })));
      pending.clear();
    };

    const dispatch = (message: IncomingMessage): Effect.Effect<void> => {
      if (message.method !== undefined && message.id !== undefined) {
        const id = message.id;
        return handlers.onRequest(message.method, message.params).pipe(
          Effect.matchEffect({
            onSuccess: (result) => write({ jsonrpc: "2.0", id, result }),
            onFailure: (error) =>
              write({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } }),
          }),
        );
      }
      if (message.method !== undefined) {
        return handlers.onNotification(message.method, message.params);
      }
      if (message.id !== undefined) {
        const deferred = pending.get(message.id);
        if (!deferred) return Effect.void;
        pending.delete(message.id);
        return message.error
          ? Deferred.fail(
              deferred,
              new JsonRpcFailure({
                message: message.error.message ?? `JSON-RPC error ${message.error.code}`,
                ...(typeof message.error.code === "number" ? { code: message.error.code } : {}),
              }),
            ).pipe(Effect.asVoid)
          : Deferred.succeed(deferred, message.result).pipe(Effect.asVoid);
      }
      return Effect.void;
    };

    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.trim().length === 0) return;
      let message: IncomingMessage;
      try {
        message = JSON.parse(line) as IncomingMessage;
      } catch {
        if (handlers.onStdoutText) run(handlers.onStdoutText(line));
        return;
      }
      if (typeof message !== "object" || message === null) return;
      run(dispatch(message));
    });

    if (handlers.onStderr) {
      const onStderr = handlers.onStderr;
      createInterface({ input: child.stderr }).on("line", (line) => run(onStderr(line)));
    } else {
      child.stderr.resume();
    }

    const onExit = (reason: string) => {
      if (exited) return;
      exited = true;
      failAllPending(reason);
      run(handlers.onExit(reason));
    };
    child.on("error", (error) => onExit(`${options.command} failed: ${error.message}`));
    child.on("exit", (code, signal) =>
      onExit(`${options.command} exited (${signal ?? `code ${code}`})`),
    );

    return {
      request: (method, params) =>
        Effect.gen(function* () {
          if (exited) return yield* Effect.fail(new JsonRpcFailure({ message: `${options.command} is not running` }));
          const id = nextId++;
          const deferred = yield* Deferred.make<unknown, JsonRpcFailure>();
          pending.set(id, deferred);
          yield* write({ jsonrpc: "2.0", id, method, params });
          return yield* Deferred.await(deferred);
        }),
      notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    };
  });
