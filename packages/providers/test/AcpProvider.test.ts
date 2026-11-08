import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RuntimeMode } from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { opencodePermissions } from "../src/AcpAgents.ts";
import { makeAcpProvider } from "../src/AcpProvider.ts";
import { autoDecision } from "../src/AgentSupport.ts";
import type { ProviderEmission, ProviderSession, ProviderSessionOptions } from "../src/Provider.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.mjs");

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "apollo-acp-test-"));
  const log = join(dir, "log.jsonl");
  const provider = makeAcpProvider({
    kind: "cursor",
    name: "Fake",
    installHint: "",
    launch: () => Effect.succeed({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_LOG: log } }),
  });
  const entries = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { dir, provider, entries };
};

const options = (cwd: string, overrides: Partial<ProviderSessionOptions> = {}): ProviderSessionOptions => ({
  cwd,
  model: null,
  effort: null,
  resumeId: null,
  instructions: "Be brief.",
  runtimeMode: "approval-required",
  mcp: { name: "apollo", url: "http://127.0.0.1:1/mcp", bearerToken: "tok" },
  skillsPluginDir: null,
  ...overrides,
});

/** Opens a session, collecting what it emits; `onEvent` can answer approvals. */
const open = (
  provider: ReturnType<typeof setup>["provider"],
  opts: ProviderSessionOptions,
  onEvent: (event: AgentEvent, session: ProviderSession) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const emitted: Array<ProviderEmission> = [];
    let session: ProviderSession | null = null;
    session = yield* provider.open(opts, (e) =>
      Effect.suspend(() => {
        emitted.push(e);
        return e._tag === "Event" && session ? onEvent(e.event, session).pipe(Effect.forkDetach, Effect.asVoid) : Effect.void;
      }),
    );
    const events = () => emitted.flatMap((e) => (e._tag === "Event" ? [e.event] : []));
    const turnDone = Effect.gen(function* () {
      for (let i = 0; i < 200 && !events().some((e) => e._tag === "TurnCompleted"); i++) yield* Effect.sleep("25 millis");
    });
    return { session, emitted, events, turnDone };
  });

describe("AcpProvider", () => {
  it.live("lists the models and effort levels a session offers", () =>
    Effect.gen(function* () {
      const { provider } = setup();
      expect(yield* provider.listModels).toEqual([
        { id: "fast", label: "Fast", description: "", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
        { id: "smart", label: "Smart", description: "Thinks harder", isDefault: false, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      ]);
    }),
  );

  it.live("runs a turn: thoughts, text, a tool call the user approves, usage", () =>
    Effect.gen(function* () {
      const { dir, provider, entries } = setup();
      const { session, emitted, events, turnDone } = yield* open(provider, options(dir, { model: "smart", effort: "high" }), (event, s) =>
        event._tag === "ApprovalRequested" ? s.respondApproval(event.requestId, "accept").pipe(Effect.orDie) : Effect.void,
      );
      expect(emitted[0]).toEqual({ _tag: "ResumeId", resumeId: "fake-session" });
      yield* session.send("Say hello");
      yield* turnDone;

      const settled = events().filter((e) => e._tag !== "AssistantDelta" && e._tag !== "ReasoningDelta");
      expect(settled.map((e) => e._tag)).toEqual([
        "TurnStarted",
        "Reasoning",
        "AssistantMessage",
        "ToolStarted",
        "ToolStarted",
        "ApprovalRequested",
        "ApprovalResolved",
        "ToolCompleted",
        "AssistantMessage",
        "TurnCompleted",
      ]);
      const tools = settled.filter((e) => e._tag === "ToolStarted");
      // Shown at once with no summary (the title was a placeholder), filled in with its input.
      expect(tools.map((t) => (t._tag === "ToolStarted" ? [t.name, t.summary] : null))).toEqual([
        ["shell", ""],
        ["shell", "echo hi"],
      ]);
      expect(settled.find((e) => e._tag === "ToolCompleted")).toMatchObject({ output: "hi", isError: false });
      expect(settled.filter((e) => e._tag === "AssistantMessage").map((e) => (e._tag === "AssistantMessage" ? e.text : ""))).toEqual(["Hello", "Done."]);
      expect(settled.at(-1)).toEqual({ _tag: "TurnCompleted", outcome: "completed", error: null });
      expect(emitted).toContainEqual({ _tag: "ContextUsage", used: 1200, window: 200000 });

      const log = entries();
      // Apollo's MCP server over HTTP, the chosen model and effort, the instructions ahead of the first message.
      expect(log.find((e) => e.method === "session/new")?.params).toMatchObject({
        mcpServers: [{ type: "http", name: "apollo", url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization", value: "Bearer tok" }] }],
      });
      expect(log.filter((e) => e.method === "session/set_config_option").map((e) => e.params)).toEqual([
        { sessionId: "fake-session", configId: "model", value: "smart" },
        { sessionId: "fake-session", configId: "effort", value: "high" },
      ]);
      expect(String(log.find((e) => e.prompt)?.prompt)).toMatch(/^<apollo_instructions>\nBe brief\.\n<\/apollo_instructions>\n\nSay hello$/);
      expect(log.find((e) => e.permission)?.permission).toEqual({ outcome: "selected", optionId: "yes" });
    }).pipe(Effect.scoped),
  );

  it.live("answers permission requests itself in full access and read-only sessions", () =>
    Effect.gen(function* () {
      for (const [mode, readOnly, expected] of [
        ["full-access", false, { outcome: "selected", optionId: "always" }],
        ["approval-required", true, { outcome: "selected", optionId: "no" }],
      ] as const) {
        const { dir, provider, entries } = setup();
        const { session, events, turnDone } = yield* open(provider, options(dir, { runtimeMode: mode, readOnly }));
        yield* session.send("Say hello");
        yield* turnDone;
        expect(events().some((e) => e._tag === "ApprovalRequested")).toBe(false);
        expect(entries().find((e) => e.permission)?.permission).toEqual(expected);
      }
    }).pipe(Effect.scoped),
  );

  it.live("reopens a conversation without replaying it or repeating the instructions", () =>
    Effect.gen(function* () {
      const { dir, provider, entries } = setup();
      const { session, emitted, turnDone } = yield* open(provider, options(dir, { resumeId: "earlier", runtimeMode: "full-access" }));
      expect(emitted[0]).toEqual({ _tag: "ResumeId", resumeId: "earlier" });
      yield* session.send("Again");
      yield* turnDone;
      expect(entries().find((e) => e.method === "session/load")?.params).toMatchObject({ sessionId: "earlier" });
      expect(entries().find((e) => e.prompt)?.prompt).toBe("Again");
    }).pipe(Effect.scoped),
  );

  it.live("interrupts a turn, and queues messages sent while one runs", () =>
    Effect.gen(function* () {
      const { dir, provider, entries } = setup();
      const { session, events, turnDone } = yield* open(provider, options(dir, { runtimeMode: "full-access" }));
      yield* session.send("wait for me");
      yield* Effect.sleep("100 millis");
      yield* session.send("queued");
      yield* session.interrupt;
      yield* turnDone;
      expect(events().filter((e) => e._tag === "TurnCompleted")).toEqual([{ _tag: "TurnCompleted", outcome: "interrupted", error: null }]);
      // An interrupt drops the queue too.
      yield* Effect.sleep("100 millis");
      expect(entries().filter((e) => e.prompt).length).toBe(1);
    }).pipe(Effect.scoped),
  );
});

describe("agent permissions", () => {
  it("asks for what the runtime mode does not allow", () => {
    const cases: Array<[RuntimeMode, boolean, Parameters<typeof autoDecision>[2], ReturnType<typeof autoDecision>]> = [
      ["approval-required", false, "read", "allow"],
      ["approval-required", false, "edit", "ask"],
      ["approval-required", false, "execute", "ask"],
      ["auto", false, "edit", "allow"],
      ["auto", false, "execute", "ask"],
      ["full-access", false, "execute", "allow"],
      ["full-access", true, "execute", "reject"],
      ["approval-required", true, "other", "allow"],
    ];
    for (const [mode, readOnly, kind, expected] of cases) expect(autoDecision(mode, readOnly, kind)).toBe(expected);
  });

  it("gives OpenCode rules that match the runtime mode", () => {
    expect(opencodePermissions("full-access", false)).toEqual({ edit: "allow", bash: "allow", webfetch: "allow" });
    expect(opencodePermissions("approval-required", true)).toEqual({ edit: "deny", bash: "deny", webfetch: "allow" });
  });
});
