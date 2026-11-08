/**
 * A Pi extension Apollo loads with `--extension`: Pi has no MCP client of its own, so this
 * registers Apollo's MCP tools as Pi tools, asks before risky tool calls (Pi leaves
 * permissions to extensions; the question reaches Apollo as an `extension_ui_request`),
 * and appends Apollo's instructions to the system prompt. Settings come from the
 * environment Apollo starts Pi with.
 */
export const PI_EXTENSION_SOURCE = String.raw`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { Type } from "typebox";

const env = (name: string) => (process.env[name] ? process.env[name] : undefined);
const MODE = env("APOLLO_PI_MODE") ?? "full-access";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "tool_search"]);
const EDIT_TOOLS = new Set(["edit", "write"]);
const PREFIX = "mcp__apollo__";
const PROTOCOL = "2025-06-18";

function mcpClient(url: string, token: string) {
  let id = 1;
  let session: string | undefined;
  const headers = () => {
    const h: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL,
    };
    if (session) h["mcp-session-id"] = session;
    return h;
  };
  const request = async (method: string, params: unknown, signal?: AbortSignal) => {
    const response = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }), signal });
    const next = response.headers.get("mcp-session-id");
    if (next) session = next;
    const body = await response.text();
    if (!response.ok) throw new Error("Apollo MCP " + method + " failed (" + response.status + "): " + body.slice(0, 300));
    let message: any;
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of body.split("\n")) {
        if (!line.startsWith("data:") || !line.slice(5).trim()) continue;
        const parsed = JSON.parse(line.slice(5));
        if (parsed.id !== undefined) message = parsed;
      }
    } else if (body.trim()) message = JSON.parse(body);
    if (message?.error) throw new Error(message.error.message ?? "Apollo MCP " + method + " failed");
    return message?.result;
  };
  return {
    async connect(signal?: AbortSignal) {
      await request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "apollo-pi", version: "1.0.0" } }, signal);
      await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal }).catch(() => undefined);
    },
    async tools(signal?: AbortSignal) {
      const tools: any[] = [];
      let cursor: string | undefined;
      do {
        const page = await request("tools/list", cursor ? { cursor } : {}, signal);
        tools.push(...(page?.tools ?? []));
        cursor = page?.nextCursor;
      } while (cursor);
      return tools;
    },
    call: (name: string, args: unknown, signal?: AbortSignal) => request("tools/call", { name, arguments: args }, signal),
  };
}

const parameters = (schema: any) => {
  const unsafe = (Type as any).Unsafe;
  return typeof unsafe === "function" && schema
    ? unsafe({ ...schema, type: schema.type ?? "object", ...(schema.properties === undefined ? { properties: {} } : {}) })
    : Type.Object({}, { additionalProperties: true });
};

const content = (result: any) => {
  const out: any[] = [];
  for (const part of result?.content ?? []) {
    if (part?.type === "text" && typeof part.text === "string") out.push({ type: "text", text: part.text });
    else if (part?.type === "image" && part.data && part.mimeType) out.push({ type: "image", data: part.data, mimeType: part.mimeType });
  }
  if (out.length === 0) out.push({ type: "text", text: JSON.stringify(result?.structuredContent ?? result ?? null) });
  return out;
};

export default async function apollo(pi: ExtensionAPI) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    const name = event.toolName as string;
    if (MODE === "full-access" || READ_ONLY_TOOLS.has(name) || name.startsWith(PREFIX)) return;
    if (MODE === "read-only") return { block: true, reason: name + " is not allowed in a read-only session." };
    if (MODE === "auto" && EDIT_TOOLS.has(name)) return;
    let input = "";
    try { input = JSON.stringify(event.input, null, 2).slice(0, 4000); } catch { input = String(event.input); }
    const ok = await ctx.ui.confirm("Allow " + name + "?", input, { signal: ctx.signal });
    if (!ok) return { block: true, reason: name + " was declined in Apollo." };
  });

  const instructionsFile = env("APOLLO_PI_INSTRUCTIONS");
  pi.on("before_agent_start", (event: any) => {
    if (!instructionsFile) return;
    let text = "";
    try { text = readFileSync(instructionsFile, "utf8").trim(); } catch { return; }
    if (text) return { systemPrompt: event.systemPrompt + "\n\n" + text };
  });

  const url = env("APOLLO_MCP_URL");
  const token = env("APOLLO_MCP_TOKEN");
  if (!url || !token) return;
  const client = mcpClient(url, token);
  let started: Promise<void> | undefined;
  const start = () => {
    started ??= (async () => {
      const signal = AbortSignal.timeout(10000);
      await client.connect(signal);
      for (const tool of await client.tools(signal)) {
        pi.registerTool({
          name: PREFIX + tool.name,
          label: tool.name,
          description: tool.description ?? tool.name,
          parameters: parameters(tool.inputSchema),
          async execute(_id: string, params: unknown, signal?: AbortSignal) {
            const result = await client.call(tool.name, params ?? {}, signal);
            return { content: content(result), details: { server: "apollo", tool: tool.name }, ...(result?.isError ? { isError: true } : {}) };
          },
        } as any);
      }
    })().catch((error) => {
      started = undefined;
      throw error;
    });
    return started;
  };
  await start().catch(() => undefined);
  pi.on("session_start", async (_event: any, ctx: any) => {
    try { await start(); } catch (error) { ctx.ui.notify("Apollo's tools are unavailable: " + String((error as Error)?.message ?? error), "warning"); }
  });
}
`;
