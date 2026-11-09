import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  cappedContextSize,
  foldSystemMessages,
  llamaCppContextSize,
  llamaCppEnvironment,
  makeLlamaCppProvider,
  startProxy,
} from "../src/LlamaCppProvider.ts";
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

  it("caps the context Claude Code is told about at the user's limit", () => {
    // Cap below the server's context: the cap wins, so compaction starts sooner.
    expect(cappedContextSize(262_144, 131_072)).toBe(131_072);
    // Cap above it: never claim more than llama-server has.
    expect(cappedContextSize(65_536, 131_072)).toBe(65_536);
    // No cap: what llama-server measured, as before.
    expect(cappedContextSize(262_144, null)).toBe(262_144);
    // Unknown server context: the cap alone, rather than Claude Code's 200k default.
    expect(cappedContextSize(null, 131_072)).toBe(131_072);
    expect(cappedContextSize(null, null)).toBeNull();
  });

  it.live("applies the cap to the measured context, or alone when there is none", () =>
    Effect.gen(function* () {
      const server = yield* fakeServer;
      const measured = yield* llamaCppContextSize({ baseUrl: server.baseUrl, apiKey: null }, MODEL);
      expect(measured).toBe(32768);
      const env = (cap: number | null, size: number | null) =>
        llamaCppEnvironment({ baseUrl: server.baseUrl, apiKey: null }, MODEL, cappedContextSize(size, cap)).CLAUDE_CODE_MAX_CONTEXT_TOKENS;
      expect(env(16_384, measured)).toBe("16384");
      expect(env(131_072, measured)).toBe("32768");
      expect(env(null, measured)).toBe("32768");
      const unknown = yield* llamaCppContextSize({ baseUrl: "http://127.0.0.1:9", apiKey: null }, MODEL);
      expect(unknown).toBeNull();
      expect(env(98_304, unknown)).toBe("98304");
      expect(env(null, unknown)).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it("never lets Anthropic credentials reach llama-server", () => {
    const env = llamaCppEnvironment({ baseUrl: "http://127.0.0.1:8080/", apiKey: null }, "m", 8192);
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
      ANTHROPIC_AUTH_TOKEN: "apollo-local",
      ANTHROPIC_API_KEY: "apollo-local",
      ANTHROPIC_SMALL_FAST_MODEL: "m",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "8192",
      // Deferred tool loading would void llama-server's prompt cache mid-conversation.
      ENABLE_TOOL_SEARCH: "false",
    });
    expect("CLAUDE_CODE_OAUTH_TOKEN" in env && env.CLAUDE_CODE_OAUTH_TOKEN).toBe(undefined);
  });

  it.live("survives a client cancelling a streamed response mid-way (Stop)", () =>
    Effect.gen(function* () {
      // An upstream that streams slowly, like a model generating.
      const upstream = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: ping\ndata: {}\n\n");
        const timer = setInterval(() => res.write("event: ping\ndata: {}\n\n"), 20);
        res.on("close", () => clearInterval(timer));
      });
      yield* Effect.promise(() => new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve)));
      const port = (upstream.address() as AddressInfo).port;
      const proxy = yield* startProxy({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k" });

      const abort = new AbortController();
      const response = yield* Effect.promise(() =>
        fetch(`${proxy.baseUrl}/v1/messages`, {
          method: "POST",
          signal: abort.signal,
          headers: { authorization: `Bearer ${proxy.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ stream: true, messages: [] }),
        }),
      );
      const reader = response.body!.getReader();
      yield* Effect.promise(() => reader.read());
      abort.abort();
      yield* Effect.sleep("200 millis");

      // Still serving after the cancelled stream.
      const again = yield* Effect.promise(() =>
        fetch(`${proxy.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${proxy.apiKey}` } }).then((r) => r.status),
      );
      expect(again).toBe(200);
      upstream.close();
    }).pipe(Effect.scoped),
  );

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
        // Thinking streams as it is written, then lands as one Reasoning item with the same id.
        const thinking = events.filter((e) => e._tag === "ReasoningDelta");
        expect(thinking.map((e) => (e._tag === "ReasoningDelta" ? e.text : "")).join("")).toBe("The user wants a pong.");
        const reasoning = events.find((e) => e._tag === "Reasoning");
        expect(reasoning).toMatchObject({ text: "The user wants a pong.", itemId: thinking[0]?._tag === "ReasoningDelta" ? thinking[0].itemId : "" });
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
          // The local model is told it is not Claude.
          expect(JSON.stringify(call.body?.system ?? "")).toContain("You are not Claude");
        }
        // Subagents are off by default: no Agent tool, and the model is told to use workers.
        const tools = calls.flatMap((c) => ((c.body as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name));
        expect(tools).toContain("Bash");
        expect(tools).not.toContain("Agent");
        expect(tools).not.toContain("Task");
        expect(calls.some((c) => JSON.stringify(c.body?.system ?? "").includes("Subagents are off"))).toBe(true);
        const usage = emissions.find((e) => e._tag === "UsageTotals");
        expect(usage).toMatchObject({ totals: { costUsd: 0 } });
        expect(usage?._tag === "UsageTotals" && usage.totals.outputTokens).toBeGreaterThan(0);
      }).pipe(Effect.scoped),
    90_000,
  );
});
