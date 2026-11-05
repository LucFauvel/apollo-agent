import { fileURLToPath } from "node:url";
import type { AgentEvent, ApprovalDecision, InputResponse } from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { makeCodexProvider } from "../src/CodexProvider.ts";
import type { ProviderEmission, ProviderSession } from "../src/Provider.ts";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

type Pending = Extract<AgentEvent, { _tag: "ApprovalRequested" | "InputRequested" }>;

/**
 * Runs one turn against the fake app-server. `answer` responds to the approval
 * or input request the turn raises.
 */
const runTurn = (prompt: string, answer: (session: ProviderSession, request: Pending) => Effect.Effect<void, unknown>) =>
  Effect.gen(function* () {
    const emissions: Array<ProviderEmission> = [];
    const asked = yield* Deferred.make<Pending>();
    const done = yield* Deferred.make<void>();

    const session = yield* makeCodexProvider({ executable: fakeCodex }).open(
      {
        cwd: process.cwd(),
        model: null,
        resumeId: null,
        instructions: "",
        runtimeMode: "approval-required",
        mcp: null,
        skillsPluginDir: null,
      },
      (emission) =>
        Effect.gen(function* () {
          emissions.push(emission);
          if (emission._tag !== "Event") return;
          const event = emission.event;
          if (event._tag === "ApprovalRequested" || event._tag === "InputRequested") {
            yield* Deferred.succeed(asked, event);
          }
          if (event._tag === "TurnCompleted") yield* Deferred.succeed(done, undefined);
        }),
    );

    yield* session.send(prompt);
    const request = yield* Deferred.await(asked);
    yield* answer(session, request);
    yield* Deferred.await(done).pipe(Effect.timeout("5 seconds"));

    const events = emissions.flatMap((e): Array<AgentEvent> => (e._tag === "Event" ? [e.event] : []));
    const message = events.find((e) => e._tag === "AssistantMessage");
    return {
      emissions,
      events,
      request,
      tags: events.map((e) => e._tag),
      reply: message?._tag === "AssistantMessage" ? (JSON.parse(message.text) as unknown) : null,
    };
  }).pipe(Effect.scoped);

const approve = (decision: ApprovalDecision) => (session: ProviderSession, request: Pending) =>
  session.respondApproval(request.requestId, decision);

const fill = (response: InputResponse) => (session: ProviderSession, request: Pending) =>
  session.respondInput(request.requestId, response);

describe("CodexProvider", () => {
  it.live("normalizes a turn and grants requested permissions for the session", () =>
    Effect.gen(function* () {
      const { emissions, tags, reply } = yield* runTurn("hello", approve("accept-for-session"));
      expect(emissions[0]).toEqual({ _tag: "ResumeId", resumeId: "thread-1" });
      expect(tags).toEqual([
        "TurnStarted",
        "ApprovalRequested",
        "ApprovalResolved",
        "AssistantDelta",
        "AssistantMessage",
        "TurnCompleted",
      ]);
      expect(reply).toEqual({ permissions: { network: { enabled: true } }, scope: "session" });
    }),
  );

  it.live("grants nothing when the user declines", () =>
    Effect.gen(function* () {
      const { reply } = yield* runTurn("hello", approve("decline"));
      expect(reply).toEqual({ permissions: {}, scope: "turn" });
    }),
  );

  it.live("turns MCP elicitations into a form and returns the user's values", () =>
    Effect.gen(function* () {
      const values = { repo: "acme/app", visibility: "private", stars: 3, archived: true };
      const { request, tags, reply } = yield* runTurn("please elicit", fill({ action: "accept", values }));
      expect(request).toMatchObject({
        _tag: "InputRequested",
        source: "github",
        message: "Pick a repository",
        url: null,
      });
      expect(request._tag === "InputRequested" && request.fields).toEqual([
        {
          name: "repo",
          kind: "string",
          title: "Repository",
          description: "owner/name",
          required: true,
          options: [],
          default: null,
          secret: false,
        },
        {
          name: "visibility",
          kind: "select",
          title: "visibility",
          description: "",
          required: false,
          options: [
            { value: "public", label: "Public" },
            { value: "private", label: "Private" },
          ],
          default: null,
          secret: false,
        },
        {
          name: "stars",
          kind: "integer",
          title: "stars",
          description: "",
          required: false,
          options: [],
          default: null,
          secret: false,
        },
        {
          name: "archived",
          kind: "boolean",
          title: "archived",
          description: "",
          required: false,
          options: [],
          default: false,
          secret: false,
        },
      ]);
      expect(tags).toContain("InputResolved");
      expect(reply).toEqual({ action: "accept", content: values, _meta: null });
    }),
  );

  it.live("sends no content when an elicitation is declined", () =>
    Effect.gen(function* () {
      const { reply } = yield* runTurn("elicit", fill({ action: "decline", values: { repo: "ignored" } }));
      expect(reply).toEqual({ action: "decline", content: null, _meta: null });
    }),
  );
});
