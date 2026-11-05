#!/usr/bin/env node
// Scripted stand-in for `codex app-server`: speaks just enough JSON-RPC for
// CodexProvider tests. Each turn asks for extra permissions (or, when the prompt
// mentions "elicit", fills an MCP elicitation form), then echoes the answer it
// received back as the agent message.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const pending = new Map();
let nextId = 1000;
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
      send({ method: "item/agentMessage/delta", params: { itemId: "msg-1", delta: "granted " } });
      send({
        method: "item/completed",
        params: { item: { type: "agentMessage", id: "msg-1", text: JSON.stringify(grant) } },
      });
      return send({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { ...turn, status: "completed" } },
      });
    }
    default:
      if (msg.id !== undefined) send({ id: msg.id, result: {} });
  }
});
