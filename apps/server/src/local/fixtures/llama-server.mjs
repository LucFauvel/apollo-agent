#!/usr/bin/env node
// A fake llama-server in router mode: just what Apollo's LocalModels service uses.
import { createServer } from "node:http";

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
if (args.includes("--list-devices")) {
  console.log("Available devices:\n  CUDA0: Fake GPU 9000 (8192 MiB, 7000 MiB free)");
  process.exit(0);
}
const key = arg("--api-key");
const models = new Map();
// A download a previous run left part way, like llama.cpp's unfinished-downloads.json.
if (process.env.FAKE_LLAMA_INCOMPLETE) {
  const id = process.env.FAKE_LLAMA_INCOMPLETE;
  models.set(id, { id, status: { value: "incomplete" } });
}
const clients = new Set();
const send = (event) => {
  for (const res of clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
};
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const body = async (req) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") return json(res, 200, { status: "ok" });
  if (req.headers.authorization !== `Bearer ${key}`) return json(res, 401, { error: { message: "Invalid API Key" } });
  if (url.pathname === "/models/sse") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/models" && req.method === "GET") return json(res, 200, { data: [...models.values()] });
  // A reviewer that allows what mentions "search" and asks about the rest.
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    const { messages } = await body(req);
    const text = messages.map((m) => m.content).join("\n");
    return json(res, 200, { choices: [{ message: { role: "assistant", content: /Tool: .*search/.test(text) ? "ALLOW" : "ASK" } }] });
  }
  if (url.pathname === "/v1/models") return json(res, 200, { data: [...models.values()] });
  if (url.pathname === "/models" && req.method === "POST") {
    const { model } = await body(req);
    if (!/:[^/]+$/.test(model)) return json(res, 400, { error: { message: "model validation failed, unable to download" } });
    json(res, 200, { success: true });
    const file = `https://huggingface.co/${model}.gguf`;
    // "Slow" models never finish: they stand for a download cut short.
    if (model.includes("Slow") || process.env.FAKE_LLAMA_SLOW === "1") {
      setTimeout(() => send({ model, event: "download_progress", data: { progress: { [file]: { done: 300, total: 1000 } } } }), 30);
      return;
    }
    for (const done of [0, 500, 1000]) {
      await new Promise((r) => setTimeout(r, 30));
      send({ model, event: "download_progress", data: { progress: { [file]: { done, total: 1000 } } } });
    }
    models.set(model, {
      id: model,
      status: { value: "unloaded" },
      memory: { max: { n_ctx: 65536, devices: [{ kind: "device", model: 900 * 2 ** 20 }, { kind: "host", model: 0 }] } },
    });
    send({ model, event: "download_finished", data: {} });
    return;
  }
  if (url.pathname === "/models" && req.method === "DELETE") {
    const model = url.searchParams.get("model");
    models.delete(model);
    send({ model, event: "model_remove" });
    return json(res, 200, { success: true });
  }
  json(res, 404, { error: { message: "not found" } });
}).listen(Number(arg("--port")), arg("--host"));
console.log(`fake llama-server listening on ${arg("--port")} (LLAMA_CACHE=${process.env.LLAMA_CACHE})`);
