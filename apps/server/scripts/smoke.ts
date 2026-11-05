/**
 * End-to-end smoke test against a running Apollo server (real providers, uses tokens).
 *
 *   APOLLO_PAIRING_LINK="$(node src/bin.ts pair --label smoke | head -1)" \
 *     node scripts/smoke.ts [workdir]
 *
 * The pairing link is redeemed for a bearer session (APOLLO_SESSION_TOKEN can be
 * passed instead to reuse one).
 *
 * Creates a bot whose Claude main session delegates to a Codex worker through
 * Apollo's MCP tools, then prints the orchestrator's transcript.
 */
import { ApolloRpcs, type SessionEvent } from "@apollo/contracts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Socket from "effect/socket/Socket";

const server = process.env.APOLLO_SERVER ?? "http://127.0.0.1:4317";
const cwd = process.argv[2] ?? process.cwd();

/** Redeems a pairing link for a bearer session token. */
const sessionToken = async (): Promise<string> => {
  if (process.env.APOLLO_SESSION_TOKEN) return process.env.APOLLO_SESSION_TOKEN;
  const link = process.env.APOLLO_PAIRING_LINK ?? "";
  const token = decodeURIComponent(/token=([^&\s]+)/.exec(link)?.[1] ?? link);
  const response = await fetch(`${server}/api/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, label: "smoke test", bearer: true }),
  });
  const body = (await response.json()) as { sessionToken?: string; error?: string };
  if (!body.sessionToken) throw new Error(`pairing failed: ${body.error ?? response.status}`);
  return body.sessionToken;
};

const layerProtocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(
    Socket.layerWebSocket(`${server.replace(/^http/, "ws")}/rpc`, {
      headers: { authorization: `Bearer ${await sessionToken()}` },
    }),
  ),
  // The global constructor rejects handshake headers; the Node one supports them.
  Layer.provide(NodeSocket.layerWebSocketConstructor),
  Layer.provide(RpcSerialization.layerJson),
);

const print = ({ seq, event }: SessionEvent) => {
  switch (event._tag) {
    case "AssistantDelta":
      return;
    case "UserMessage":
      return console.log(`#${seq} ${event.author}> ${event.text}`);
    case "AssistantMessage":
      return console.log(`#${seq} assistant> ${event.text}`);
    case "ToolStarted":
      return console.log(`#${seq} tool ${event.name}: ${event.summary}`);
    case "ToolCompleted":
      return console.log(`#${seq}   -> ${event.isError ? "ERROR " : ""}${event.output.slice(0, 300)}`);
    default:
      return console.log(`#${seq} ${JSON.stringify(event)}`);
  }
};

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(ApolloRpcs);

  const bot = yield* client["bots.create"]({
    name: "Smoke",
    instructions: "Be terse.",
    cwd,
    main: { provider: "claude" },
    defaultWorker: { provider: "codex" },
    runtimeMode: "full-access",
    autoLearn: false,
  });
  console.log(`bot ${bot.id}, main session ${bot.mainSessionId}`);

  yield* client["sessions.send"]({
    sessionId: bot.mainSessionId,
    text: [
      "Smoke test, follow exactly:",
      "1. Save a memory (kind preference) that the user's favorite color is teal.",
      "2. Spawn a codex worker titled 'pong' with the prompt 'Reply with the single word PONG.' and notifyOnCompletion false.",
      "3. Wait for it with apollo_wait_session, then tell me what it replied.",
    ].join("\n"),
  });

  yield* client["sessions.events"]({ sessionId: bot.mainSessionId, afterSeq: 0 }).pipe(
    Stream.tap((e) => Effect.sync(() => print(e))),
    Stream.takeUntil((e) => e.event._tag === "TurnCompleted"),
    Stream.runDrain,
    Effect.timeout(Duration.minutes(4)),
  );

  const snapshot = yield* client["app.snapshot"]();
  for (const s of snapshot.sessions.filter((s) => s.botId === bot.id)) {
    console.log(`session ${s.role} ${s.provider} ${s.status} "${s.title}": ${s.lastMessage ?? ""}`);
  }
  const memories = yield* client["memory.list"]({ botId: bot.id });
  console.log("memories:", memories.map((m) => m.content));
}).pipe(Effect.scoped, Effect.provide(layerProtocol));

NodeRuntime.runMain(program);
