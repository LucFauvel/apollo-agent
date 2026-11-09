import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "./Config.ts";
import * as Database from "./Database.ts";
import { ProviderSettings, layer as settingsLayer } from "./ProviderSettings.ts";
import * as Store from "./Store.ts";

const layer = settingsLayer.pipe(
  Layer.provideMerge(Store.layer),
  Layer.provideMerge(Database.layerMemory),
  Layer.provideMerge(
    Layer.succeed(ServerConfig, {
      llamaCpp: { baseUrl: "http://127.0.0.1:8080", apiKey: null },
    } as unknown as ServerConfig["Service"]),
  ),
);

describe("provider settings", () => {
  it.effect("defaults to the Claude login and the configured llama-server", () =>
    Effect.gen(function* () {
      const settings = yield* ProviderSettings;
      expect(yield* settings.view).toEqual({
        claude: { auth: "subscription", apiKeySaved: false },
        // Local models start no subagents unless the user allows it.
        llamacpp: { mode: "managed", baseUrl: "http://127.0.0.1:8080", apiKeySaved: false, allowSubagents: false, maxContextTokens: null },
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("saves a context cap, rejects one too small to work, and clears it", () =>
    Effect.gen(function* () {
      const settings = yield* ProviderSettings;
      const capped = yield* settings.update({ llamacpp: { maxContextTokens: 131_072 } });
      expect(capped.llamacpp.maxContextTokens).toBe(131_072);
      expect((yield* settings.read).llamacpp.maxContextTokens).toBe(131_072);

      // Below Claude Code's own prompt plus its compaction reserve, or not a token count.
      for (const bad of [65_536, 98_303, 131_072.5, Number.NaN, -1, 1e12]) {
        const error = yield* Effect.flip(settings.update({ llamacpp: { maxContextTokens: bad, allowSubagents: true } }));
        expect(error.code).toBe("invalid");
      }
      // A rejected update saves nothing, not even its other fields.
      expect((yield* settings.read).llamacpp).toMatchObject({ maxContextTokens: 131_072, allowSubagents: false });

      // Leaving it out keeps it; null removes it.
      yield* settings.update({ llamacpp: { allowSubagents: true } });
      expect((yield* settings.read).llamacpp.maxContextTokens).toBe(131_072);
      expect((yield* settings.update({ llamacpp: { maxContextTokens: null } })).llamacpp.maxContextTokens).toBeNull();
      expect((yield* settings.update({ llamacpp: { maxContextTokens: 98_304 } })).llamacpp.maxContextTokens).toBe(98_304);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps keys write-only, and keeps them when switching back to the login", () =>
    Effect.gen(function* () {
      const settings = yield* ProviderSettings;
      const view = yield* settings.update({ claude: { auth: "api-key", apiKey: " sk-ant-123 " } });
      expect(view.claude).toEqual({ auth: "api-key", apiKeySaved: true });
      expect(JSON.stringify(view)).not.toContain("sk-ant");
      expect((yield* settings.read).claude.apiKey).toBe("sk-ant-123");

      yield* settings.update({ claude: { auth: "subscription" } });
      expect((yield* settings.read).claude).toEqual({ auth: "subscription", apiKey: "sk-ant-123" });

      yield* settings.update({ claude: { apiKey: null }, llamacpp: { baseUrl: "http://gpu-box:8080", apiKey: "k" } });
      expect(yield* settings.read).toEqual({
        claude: { auth: "subscription", apiKey: null },
        llamacpp: { mode: "managed", baseUrl: "http://gpu-box:8080", apiKey: "k", allowSubagents: false, maxContextTokens: null },
      });

      const allowed = yield* settings.update({ llamacpp: { allowSubagents: true } });
      expect(allowed.llamacpp.allowSubagents).toBe(true);
      expect((yield* settings.read).llamacpp.allowSubagents).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});
