import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApolloError, type BotId, type SecretResponse, type SessionId } from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../Config.ts";
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";
import { findOp, OnePassword } from "./OnePassword.ts";

/**
 * Secrets agents ask the user for (`apollo_request_secret`). The user types the
 * value or picks a 1Password field in a private card; the agent never sees it.
 * It gets either a one-use `secretRef` (for Apollo tools such as the browser) or
 * the path of a private file to read inside a shell command. Values live in
 * memory or in 0600 files under `<data>/secrets`, deleted after `SECRET_TTL_MS`
 * and at startup; they are never written to the event log.
 */

const SECRET_TTL_MS = 15 * 60_000;

type Answer = { readonly value: string; readonly source: "typed" | "1password" } | "declined";

interface PendingRequest {
  readonly sessionId: SessionId;
  readonly deferred: Deferred.Deferred<Answer, ApolloError>;
}

interface StoredSecret {
  readonly botId: BotId;
  readonly value: string;
  readonly expiresAt: number;
}

export interface SecretRequest {
  readonly label: string;
  readonly reason: string;
  readonly placeholder: string | undefined;
  readonly delivery: "secretRef" | "file";
  readonly timeoutMs: number;
}

const invalid = (message: string) => new ApolloError({ code: "invalid", message });
const token = (prefix: string) => `${prefix}_${randomBytes(18).toString("base64url")}`;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const manager = yield* SessionManager;
  const store = yield* Store;
  const onePassword = new OnePassword(findOp(process.env.APOLLO_OP_BIN));
  const pending = new Map<string, PendingRequest>();
  const refs = new Map<string, StoredSecret>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const dir = join(config.dataDir, "secrets");
  // Files from an earlier run are past their use.
  rmSync(dir, { recursive: true, force: true });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const timer of timers) clearTimeout(timer);
      refs.clear();
      rmSync(dir, { recursive: true, force: true });
    }),
  );

  const later = (ms: number, f: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      f();
    }, ms);
    timers.add(timer);
  };

  const deliver = (botId: BotId, delivery: SecretRequest["delivery"], value: string) => {
    const expiresAt = Date.now() + SECRET_TTL_MS;
    if (delivery === "file") {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const path = join(dir, token("secret"));
      writeFileSync(path, value, { mode: 0o600 });
      later(SECRET_TTL_MS, () => rmSync(path, { force: true }));
      return { delivery, secretRef: null, path, expiresInSeconds: SECRET_TTL_MS / 1000 };
    }
    const ref = token("sref");
    refs.set(ref, { botId, value, expiresAt });
    later(SECRET_TTL_MS, () => refs.delete(ref));
    return { delivery, secretRef: ref, path: null, expiresInSeconds: SECRET_TTL_MS / 1000 };
  };

  const resolved = (sessionId: SessionId, requestId: string, outcome: "provided" | "declined" | "expired", source: "typed" | "1password" | null) =>
    manager.appendEvent(sessionId, { _tag: "SecretResolved", requestId, outcome, source });

  /** Asks the user and waits for the answer (or the timeout, or the turn being interrupted). */
  const request = (caller: { sessionId: SessionId; botId: BotId }, input: SecretRequest) =>
    Effect.gen(function* () {
      const label = input.label.trim();
      if (!label) return yield* invalid("`label` is required, e.g. \"GitHub token\"");
      const requestId = token("secretreq");
      const deferred = yield* Deferred.make<Answer, ApolloError>();
      pending.set(requestId, { sessionId: caller.sessionId, deferred });

      yield* manager.appendEvent(caller.sessionId, {
        _tag: "SecretRequested",
        requestId,
        label: label.slice(0, 120),
        reason: input.reason.trim().slice(0, 600),
        placeholder: input.placeholder?.trim() || null,
      });
      const bot = yield* store.getBot(caller.botId);
      yield* manager.publish({
        _tag: "Notify",
        botId: caller.botId,
        sessionId: caller.sessionId,
        title: `${bot.name} needs a secret`,
        body: label,
      });

      const answer = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(Duration.millis(input.timeoutMs)),
        Effect.onInterrupt(() => resolved(caller.sessionId, requestId, "expired", null).pipe(Effect.ignore)),
        Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
      );
      if (Option.isNone(answer)) {
        yield* resolved(caller.sessionId, requestId, "expired", null);
        return yield* invalid(`the user did not provide "${label}" within ${Math.round(input.timeoutMs / 1000)} s`);
      }
      if (answer.value === "declined") {
        return yield* invalid(`the user declined to provide "${label}"; do not ask again unless they say so`);
      }
      return deliver(caller.botId, input.delivery, answer.value.value);
    });

  /** The user's answer from the UI. 1Password values are read here, on the server. */
  const respond = (sessionId: SessionId, requestId: string, response: SecretResponse) =>
    Effect.gen(function* () {
      const request = pending.get(requestId);
      if (!request || request.sessionId !== sessionId) {
        return yield* invalid("this request is no longer waiting (it expired, or Apollo restarted)");
      }
      switch (response._tag) {
        case "decline":
          yield* resolved(sessionId, requestId, "declined", null);
          yield* Deferred.succeed(request.deferred, "declined");
          return;
        case "typed": {
          if (!response.value) return yield* invalid("the secret is empty");
          yield* resolved(sessionId, requestId, "provided", "typed");
          yield* Deferred.succeed(request.deferred, { value: response.value, source: "typed" });
          return;
        }
        case "onePassword": {
          const value = yield* Effect.tryPromise({
            try: () => onePassword.read(response.reference),
            catch: (error) => invalid((error as Error).message),
          });
          yield* resolved(sessionId, requestId, "provided", "1password");
          yield* Deferred.succeed(request.deferred, { value, source: "1password" });
          return;
        }
      }
    });

  /** Uses a `secretRef` once (it is consumed), for the same bot that requested it. */
  const take = (botId: BotId, ref: string) =>
    Effect.gen(function* () {
      const secret = refs.get(ref);
      if (!secret || secret.expiresAt < Date.now()) return yield* invalid("unknown or expired secretRef: ask again with apollo_request_secret");
      if (secret.botId !== botId) return yield* invalid("that secretRef belongs to another bot");
      refs.delete(ref);
      return secret.value;
    });

  const op = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (error) => invalid((error as Error).message) });

  return {
    request,
    respond,
    take,
    onePasswordStatus: op(() => onePassword.status()),
    onePasswordSearch: (query: string) => op(() => onePassword.search(query)),
    onePasswordFields: (itemId: string, vaultId: string) => op(() => onePassword.fields(itemId, vaultId)),
  };
});

export class Secrets extends Context.Service<Secrets, Effect.Success<typeof make>>()("apollo/Secrets") {}

export const layer = Layer.effect(Secrets, make);

/** Exposed for tests: whether `<data>/secrets` holds files. */
export const secretFiles = (dataDir: string) => {
  try {
    return readdirSync(join(dataDir, "secrets"));
  } catch {
    return [];
  }
};
