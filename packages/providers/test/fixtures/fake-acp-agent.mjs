// A minimal ACP agent for tests: one model config option, a turn that thinks, streams a
// reply, runs a command after asking permission, and records what it was sent.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_ACP_LOG;
const record = (entry) => log && appendFileSync(log, `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });

let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

let cancel = null;

const prompt = async (id, params) => {
  const sid = params.sessionId;
  const text = params.prompt.map((b) => b.text ?? "").join("");
  record({ prompt: text });
  if (text.includes("wait")) {
    await new Promise((resolve) => (cancel = resolve));
    return send({ id, result: { stopReason: "cancelled" } });
  }
  update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking it over" } });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
  update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Terminal", kind: "execute", status: "pending" });
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", rawInput: { command: "echo hi" }, status: "in_progress" });
  const answer = await ask("session/request_permission", {
    sessionId: sid,
    toolCall: { toolCallId: "t1", title: "echo hi", kind: "execute" },
    options: [
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "always", name: "Always", kind: "allow_always" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  });
  record({ permission: answer.outcome });
  const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId !== "no";
  update(sid, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: allowed ? "completed" : "failed",
    rawOutput: allowed ? { stdout: "hi" } : undefined,
    content: allowed ? [] : [{ type: "content", content: { type: "text", text: "rejected" } }],
  });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
  update(sid, { sessionUpdate: "usage_update", used: 1200, size: 200000 });
  send({ id, result: { stopReason: "end_turn" } });
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && message.method === undefined) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  record({ method, params: method === "session/prompt" ? undefined : params });
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: false } },
          authMethods: [],
        },
      });
    case "session/new":
    case "session/load":
      return send({
        id,
        result: {
          sessionId: params.sessionId ?? "fake-session",
          configOptions: [
            {
              id: "model",
              category: "model",
              type: "select",
              currentValue: "fast",
              options: [
                { value: "fast", name: "Fast" },
                { value: "smart", name: "Smart", description: "Thinks harder" },
              ],
            },
            { id: "effort", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
          ],
        },
      });
    case "session/set_config_option":
      return send({ id, result: {} });
    case "session/prompt":
      return void prompt(id, params);
    case "session/cancel":
      return cancel?.();
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `no ${method}` } });
  }
});
