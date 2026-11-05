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
        llamacpp: { mode: "managed", baseUrl: "http://127.0.0.1:8080", apiKeySaved: false },
      });
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
        llamacpp: { mode: "managed", baseUrl: "http://gpu-box:8080", apiKey: "k" },
      });
    }).pipe(Effect.provide(layer)),
  );
});
