import type {
  ClaudeAuth,
  LlamaCppMode,
  ProviderSettings as ProviderSettingsView,
  UpdateProviderSettingsInput,
} from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "./Config.ts";
import { Store } from "./Store.ts";

/** Provider settings with their secrets, for the server's own use only. */
export interface ProviderCredentials {
  readonly claude: { readonly auth: ClaudeAuth; readonly apiKey: string | null };
  readonly llamacpp: {
    readonly mode: LlamaCppMode;
    readonly baseUrl: string;
    readonly apiKey: string | null;
    readonly allowSubagents: boolean;
  };
}

const KEYS = {
  claudeAuth: "providers.claude.auth",
  claudeApiKey: "providers.claude.apiKey",
  llamaMode: "providers.llamacpp.mode",
  llamaUrl: "providers.llamacpp.baseUrl",
  llamaApiKey: "providers.llamacpp.apiKey",
  llamaSubagents: "providers.llamacpp.allowSubagents",
} as const;

/** Empty or whitespace-only input clears a value. */
const clean = (value: string | null) => (value?.trim() ? value.trim() : null);

const make = Effect.gen(function* () {
  const store = yield* Store;
  const config = yield* ServerConfig;

  const read: Effect.Effect<ProviderCredentials> = Effect.gen(function* () {
    const auth = yield* store.getSetting(KEYS.claudeAuth);
    const mode = yield* store.getSetting(KEYS.llamaMode);
    return {
      claude: {
        auth: auth === "api-key" ? "api-key" : "subscription",
        apiKey: yield* store.getSetting(KEYS.claudeApiKey),
      },
      llamacpp: {
        mode: mode === "external" ? "external" : "managed",
        baseUrl: (yield* store.getSetting(KEYS.llamaUrl)) ?? config.llamaCpp.baseUrl,
        apiKey: (yield* store.getSetting(KEYS.llamaApiKey)) ?? config.llamaCpp.apiKey,
        // Off unless turned on: a subagent is a second model run the machine rarely has room for.
        allowSubagents: (yield* store.getSetting(KEYS.llamaSubagents)) === "true",
      },
    };
  });

  const view = Effect.map(
    read,
    (c): ProviderSettingsView => ({
      claude: { auth: c.claude.auth, apiKeySaved: c.claude.apiKey !== null },
      llamacpp: {
        mode: c.llamacpp.mode,
        baseUrl: c.llamacpp.baseUrl,
        apiKeySaved: c.llamacpp.apiKey !== null,
        allowSubagents: c.llamacpp.allowSubagents,
      },
    }),
  );

  const update = (input: UpdateProviderSettingsInput) =>
    Effect.gen(function* () {
      const { claude, llamacpp } = input;
      if (claude?.auth !== undefined) yield* store.setSetting(KEYS.claudeAuth, claude.auth);
      if (claude?.apiKey !== undefined) yield* store.setSetting(KEYS.claudeApiKey, clean(claude.apiKey));
      if (llamacpp?.mode !== undefined) yield* store.setSetting(KEYS.llamaMode, llamacpp.mode);
      if (llamacpp?.baseUrl !== undefined) yield* store.setSetting(KEYS.llamaUrl, clean(llamacpp.baseUrl));
      if (llamacpp?.apiKey !== undefined) yield* store.setSetting(KEYS.llamaApiKey, clean(llamacpp.apiKey));
      if (llamacpp?.allowSubagents !== undefined) {
        yield* store.setSetting(KEYS.llamaSubagents, String(llamacpp.allowSubagents));
      }
      return yield* view;
    });

  return { read, view, update };
});

export class ProviderSettings extends Context.Service<ProviderSettings, Effect.Success<typeof make>>()(
  "apollo/ProviderSettings",
) {}

export const layer = Layer.effect(ProviderSettings, make);
