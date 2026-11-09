import {
  ApolloError,
  type ClaudeAuth,
  LLAMACPP_MIN_CONTEXT_TOKENS,
  type LlamaCppMode,
  type ProviderSettings as ProviderSettingsView,
  type UpdateProviderSettingsInput,
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
    /** Context cap for local model sessions; `null`: none. */
    readonly maxContextTokens: number | null;
  };
}

const KEYS = {
  claudeAuth: "providers.claude.auth",
  claudeApiKey: "providers.claude.apiKey",
  llamaMode: "providers.llamacpp.mode",
  llamaUrl: "providers.llamacpp.baseUrl",
  llamaApiKey: "providers.llamacpp.apiKey",
  llamaSubagents: "providers.llamacpp.allowSubagents",
  llamaMaxContext: "providers.llamacpp.maxContextTokens",
} as const;

/** Largest cap worth accepting: no local model has more context than this. */
const MAX_CONTEXT_TOKENS = 16 * 1024 * 1024;

/** A saved cap, or `null` for none (or one that no longer passes the checks). */
const parseCap = (saved: string | null) => {
  const n = saved === null ? Number.NaN : Number(saved);
  return Number.isInteger(n) && n >= LLAMACPP_MIN_CONTEXT_TOKENS && n <= MAX_CONTEXT_TOKENS ? n : null;
};

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

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
        maxContextTokens: parseCap(yield* store.getSetting(KEYS.llamaMaxContext)),
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
        maxContextTokens: c.llamacpp.maxContextTokens,
      },
    }),
  );

  const update = (input: UpdateProviderSettingsInput) =>
    Effect.gen(function* () {
      const { claude, llamacpp } = input;
      // Checked before anything is saved, so a bad value changes nothing.
      const cap = llamacpp?.maxContextTokens;
      if (cap !== undefined && cap !== null) {
        if (!Number.isInteger(cap) || cap < LLAMACPP_MIN_CONTEXT_TOKENS || cap > MAX_CONTEXT_TOKENS) {
          return yield* Effect.fail(
            invalid(
              `The context limit must be a whole number of tokens from ${LLAMACPP_MIN_CONTEXT_TOKENS.toLocaleString("en-US")} ` +
                `(${LLAMACPP_MIN_CONTEXT_TOKENS / 1024}k) to ${MAX_CONTEXT_TOKENS.toLocaleString("en-US")}. Claude Code's own prompt ` +
                "is 30-40k tokens and it keeps ~33k free for compaction, so less would compact on every turn.",
            ),
          );
        }
      }
      if (claude?.auth !== undefined) yield* store.setSetting(KEYS.claudeAuth, claude.auth);
      if (claude?.apiKey !== undefined) yield* store.setSetting(KEYS.claudeApiKey, clean(claude.apiKey));
      if (llamacpp?.mode !== undefined) yield* store.setSetting(KEYS.llamaMode, llamacpp.mode);
      if (llamacpp?.baseUrl !== undefined) yield* store.setSetting(KEYS.llamaUrl, clean(llamacpp.baseUrl));
      if (llamacpp?.apiKey !== undefined) yield* store.setSetting(KEYS.llamaApiKey, clean(llamacpp.apiKey));
      if (llamacpp?.allowSubagents !== undefined) {
        yield* store.setSetting(KEYS.llamaSubagents, String(llamacpp.allowSubagents));
      }
      if (cap !== undefined) yield* store.setSetting(KEYS.llamaMaxContext, cap === null ? null : String(cap));
      return yield* view;
    });

  return { read, view, update };
});

export class ProviderSettings extends Context.Service<ProviderSettings, Effect.Success<typeof make>>()(
  "apollo/ProviderSettings",
) {}

export const layer = Layer.effect(ProviderSettings, make);
