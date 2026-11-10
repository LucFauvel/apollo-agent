#!/usr/bin/env node
// Scripted stand-in for `codex app-server`: speaks just enough JSON-RPC for
// CodexProvider tests. Each turn asks for extra permissions (or, when the prompt
// mentions "elicit", fills an MCP elicitation form), then echoes the answer it
// received back as the agent message.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const pending = new Map();
let nextId = 1000;
// Each read of the account's rate limits finds 10% more of the 5-hour window used.
let limitReads = 0;
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    pending.get(msg.id)?.(msg.result ?? msg.error);
    pending.delete(msg.id);
    return;
  }
  switch (msg.method) {
    case "initialize":
      return send({ id: msg.id, result: { userAgent: "fake" } });
    case "model/list": {
      // Two pages, to exercise pagination; the hidden model must be filtered out.
      const model = (id, displayName, description, efforts, extra = {}) => ({
        id,
        model: id,
        displayName,
        description,
        hidden: false,
        isDefault: false,
        supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: "" })),
        defaultReasoningEffort: efforts[0],
        ...extra,
      });
      return send({
        id: msg.id,
        result: msg.params.cursor
          ? { data: [model("gpt-deep", "GPT Deep", "Hard problems", ["medium", "high"], { isDefault: true })], nextCursor: null }
          : {
              data: [
                model("gpt-fast", "GPT Fast", "Quick edits", ["low", "medium"]),
                model("gpt-old", "GPT Old", "Retired", [], { hidden: true }),
              ],
              nextCursor: "page-2",
            },
      });
    }
    case "account/rateLimits/read": {
      limitReads++;
      const snapshot = {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 10 * limitReads, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null },
        credits: null,
        individualLimit: null,
        planType: "plus",
      };
      return send({ id: msg.id, result: { rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot } } });
    }
    case "thread/start":
    case "thread/resume":
      return send({ id: msg.id, result: { thread: { id: msg.params.threadId ?? "thread-1" } } });
    case "turn/start": {
      const turn = { id: "turn-1", status: "inProgress", error: null };
      send({ id: msg.id, result: { turn } });
      send({ method: "turn/started", params: { threadId: "thread-1", turn } });
      const grant = JSON.stringify(msg.params.input).includes("elicit")
        ? await request("mcpServer/elicitation/request", {
            threadId: "thread-1",
            turnId: "turn-1",
            serverName: "github",
            mode: "form",
            _meta: null,
            message: "Pick a repository",
            requestedSchema: {
              type: "object",
              properties: {
                repo: { type: "string", title: "Repository", description: "owner/name" },
                visibility: { type: "string", oneOf: [{ const: "public", title: "Public" }, { const: "private", title: "Private" }] },
                stars: { type: "integer", minimum: 0 },
                archived: { type: "boolean", default: false },
              },
              required: ["repo"],
            },
          })
        : await request("item/permissions/requestApproval", {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "item-1",
            reason: "needs network",
            permissions: { network: { enabled: true }, fileSystem: null },
          });
      if (JSON.stringify(msg.params.input).includes("subagent")) {
        // As codex 0.167 reports a subagent: its own thread, turn and items on this connection.
        const sub = "thread-sub";
        const subTurn = { id: "turn-sub", status: "inProgress", error: null };
        const activity = (id, kind) => ({ type: "subAgentActivity", id, kind, agentThreadId: sub, agentPath: "/root/list_files", model: null, reasoningEffort: null });
        send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: activity("act-1", "started") } });
        send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: activity("act-1", "started") } });
        send({ method: "turn/started", params: { threadId: sub, turn: subTurn } });
        const wait = { type: "collabAgentToolCall", id: "wait-1", tool: "wait", status: "inProgress", senderThreadId: "thread-1", receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {} };
        send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: wait } });
        const ls = { type: "commandExecution", id: "cmd-sub", command: "ls", aggregatedOutput: null, exitCode: null };
        send({ method: "item/started", params: { threadId: sub, turnId: "turn-sub", item: ls } });
        send({ method: "item/completed", params: { threadId: sub, turnId: "turn-sub", item: { ...ls, aggregatedOutput: "x.txt", exitCode: 0 } } });
        send({ method: "item/agentMessage/delta", params: { threadId: sub, turnId: "turn-sub", itemId: "msg-sub", delta: "Found " } });
        send({ method: "item/completed", params: { threadId: sub, turnId: "turn-sub", item: { type: "agentMessage", id: "msg-sub", text: "Found x.txt" } } });
        send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: activity("act-2", "completed") } });
        send({ method: "turn/completed", params: { threadId: sub, turn: { ...subTurn, status: "completed" } } });
        send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: activity("act-2", "completed") } });
        send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { ...wait, status: "completed" } } });
      }
      send({ method: "item/agentMessage/delta", params: { itemId: "msg-1", delta: "granted " } });
      send({
        method: "item/completed",
        params: { item: { type: "agentMessage", id: "msg-1", text: JSON.stringify(grant) } },
      });
      const breakdown = { totalTokens: 1050, inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10 };
      send({
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: null } },
      });
      // Sparse, as Codex sends it: the client re-reads the whole snapshot.
      send({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", primary: { usedPercent: 99 } } } });
      return send({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { ...turn, status: "completed" } },
      });
    }
    default:
      if (msg.id !== undefined) send({ id: msg.id, result: {} });
  }
});
