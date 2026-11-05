import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { foldSystemMessages, llamaCppEnvironment, makeLlamaCppProvider } from "../src/LlamaCppProvider.ts";
import type { ProviderEmission } from "../src/Provider.ts";
import { startFakeLlamaServer } from "./fixtures/fake-llama-server.ts";

const MODEL = "/models/Qwen3-1.5B-Q4_K_M.gguf";

const fakeServer = Effect.acquireRelease(
  Effect.promise(() => startFakeLlamaServer({ model: MODEL, contextSize: 32768, reply: "PONG" })),
  (server) => Effect.promise(server.close),
);

describe("LlamaCppProvider", () => {
  it.live("lists llama-server's models", () =>
    Effect.gen(function* () {
      const server = yield* fakeServer;
      const provider = makeLlamaCppProvider({ connection: Effect.succeed({ baseUrl: server.baseUrl, apiKey: null }) });
      expect(yield* provider.listModels).toEqual([
        {
          id: MODEL,
          label: "Qwen3-1.5B-Q4_K_M",
          description: "1.5B parameters · local",
          isDefault: true,
          efforts: [],
          defaultEffort: null,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("explains how to start llama-server when it is not running", () =>
    Effect.gen(function* () {
      const provider = makeLlamaCppProvider({
        connection: Effect.succeed({ baseUrl: "http://127.0.0.1:9", apiKey: null }),
      });
      const error = yield* Effect.flip(provider.listModels);
      expect(error.provider).toBe("llamacpp");
      expect(error.message).toContain("llama-server is not reachable at http://127.0.0.1:9");
    }),
  );

  it("never lets Anthropic credentials reach llama-server", () => {
    const env = llamaCppEnvironment({ baseUrl: "http://127.0.0.1:8080/", apiKey: null }, "m", 8192);
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
      ANTHROPIC_AUTH_TOKEN: "apollo-local",
      ANTHROPIC_API_KEY: "apollo-local",
      ANTHROPIC_SMALL_FAST_MODEL: "m",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "8192",
    });
    expect("CLAUDE_CODE_OAUTH_TOKEN" in env && env.CLAUDE_CODE_OAUTH_TOKEN).toBe(undefined);
  });

  it("folds mid-conversation system messages into the neighbouring user message", () => {
    expect(
      foldSystemMessages([
        { role: "user", content: "hi" },
        { role: "system", content: [{ type: "text", text: "env" }] },
        { role: "assistant", content: "hello" },
        { role: "system", content: "late" },
        { role: "assistant", content: "x" },
        { role: "user", content: "next" },
      ]),
    ).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "<system-reminder>\nenv\n</system-reminder>" }] },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "x" },
      { role: "user", content: [{ type: "text", text: "<system-reminder>\nlate\n</system-reminder>" }, { type: "text", text: "next" }] },
    ]);
  });

  it.live(
    "runs a Claude Code turn against llama-server",
    () =>
      Effect.gen(function* () {
        const server = yield* fakeServer;
        // Keep Claude Code's own state out of the user's ~/.claude.
        process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "apollo-llama-claude-"));
        const provider = makeLlamaCppProvider({
          connection: Effect.succeed({ baseUrl: server.baseUrl, apiKey: "secret" }),
        });
        const emissions: Array<ProviderEmission> = [];
        const done = yield* Deferred.make<void>();
        const session = yield* provider.open(
          {
            cwd: process.cwd(),
            model: null,
            effort: null,
            resumeId: null,
            instructions: "",
            runtimeMode: "full-access",
            mcp: null,
            skillsPluginDir: null,
          },
          (emission) =>
            Effect.gen(function* () {
              emissions.push(emission);
              if (emission._tag === "Event" && emission.event._tag === "TurnCompleted") {
                yield* Deferred.succeed(done, undefined);
              }
            }),
        );
        yield* session.send("Reply PONG");
        yield* Deferred.await(done).pipe(Effect.timeout("60 seconds"));

        const events = emissions.flatMap((e): Array<AgentEvent> => (e._tag === "Event" ? [e.event] : []));
        expect(events).toContainEqual(expect.objectContaining({ _tag: "AssistantMessage", text: "PONG" }));
        expect(events.at(-1)).toMatchObject({ _tag: "TurnCompleted", outcome: "completed" });

        const calls = server.requests.filter((r) => r.path === "/v1/messages");
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
          expect(call.body?.model).toBe(MODEL);
          // The proxy swaps Claude Code's throwaway token for the real key.
          expect(call.authorization).toBe("Bearer secret");
          // Chat templates only accept a system message first.
          const roles = (call.body as { messages?: Array<{ role: string }> }).messages?.map((m) => m.role) ?? [];
          expect(roles).not.toContain("system");
        }
        const usage = emissions.find((e) => e._tag === "UsageTotals");
        expect(usage).toMatchObject({ totals: { costUsd: 0 } });
        expect(usage?._tag === "UsageTotals" && usage.totals.outputTokens).toBeGreaterThan(0);
      }).pipe(Effect.scoped),
    90_000,
  );
});
