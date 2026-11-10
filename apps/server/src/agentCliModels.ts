import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentClis } from "./AgentClis.ts";
import { SessionManager } from "./SessionManager.ts";

/** A CLI just installed or signed in: forget the model list cached while it could not answer. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const clis = yield* AgentClis;
    const manager = yield* SessionManager;
    yield* clis.whenReady((provider) => manager.refreshProviderModels(provider));
  }),
);
