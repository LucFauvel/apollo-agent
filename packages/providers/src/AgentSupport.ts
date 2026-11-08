import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { RuntimeMode } from "@apollo/contracts";
import type { McpEndpoint, ProviderSessionOptions } from "./Provider.ts";

/**
 * Pieces the third-party agent adapters (ACP agents, Muse Code, Pi) share: finding their
 * CLI, telling them about Apollo's skills, reaching Apollo's MCP server, and deciding
 * which tool calls need the user.
 */

/** The first of `names` found on PATH (or an absolute path that exists), else null. */
export const findExecutable = (names: ReadonlyArray<string>, path = process.env.PATH ?? ""): string | null => {
  for (const name of names) {
    if (name.includes("/")) {
      try {
        accessSync(name, constants.X_OK);
        return name;
      } catch {
        continue;
      }
    }
    for (const dir of path.split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
};

const frontmatter = (text: string, key: string) =>
  new RegExp(`^${key}:\\s*(.+)$`, "m").exec(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "")?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";

/**
 * Apollo's skills as a note for agents that cannot load them natively: each skill's name,
 * when to use it, and the file to read before following it.
 */
export const skillsNote = (pluginDir: string | null): string => {
  if (!pluginDir) return "";
  const root = join(pluginDir, "skills");
  let names: Array<string>;
  try {
    names = readdirSync(root);
  } catch {
    return "";
  }
  const lines: Array<string> = [];
  for (const name of names.sort()) {
    const file = join(root, name, "SKILL.md");
    try {
      const text = readFileSync(file, "utf8");
      lines.push(`- ${frontmatter(text, "name") || name}: ${frontmatter(text, "description") || "(no description)"} (${file})`);
    } catch {
      // not a skill folder
    }
  }
  if (lines.length === 0) return "";
  return [
    "",
    "",
    "## Skills",
    "Saved procedures for this user. When one applies, read its SKILL.md first and follow it:",
    ...lines,
  ].join("\n");
};

/** Apollo's instructions plus the skills note, for agents without a system-prompt option. */
export const fullInstructions = (options: ProviderSessionOptions) =>
  `${options.instructions}${skillsNote(options.skillsPluginDir)}`.trim();

/** The text sent ahead of the first message of a new conversation, for agents that take no system prompt. */
export const instructionsPreamble = (options: ProviderSessionOptions) => {
  const text = fullInstructions(options);
  return text ? `<apollo_instructions>\n${text}\n</apollo_instructions>\n\n` : "";
};

/**
 * A stdio MCP server that forwards to Apollo's HTTP MCP endpoint, for agents that only
 * launch stdio servers. Runs as `node -e` with the endpoint in its environment.
 */
const MCP_STDIO_BRIDGE = String.raw`
const url = process.env.APOLLO_MCP_URL, auth = process.env.APOLLO_MCP_AUTHORIZATION;
let session;
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const fail = (id, message) => { if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32603, message } }); };
const forward = async (message) => {
  try {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: auth };
    if (session) headers["mcp-session-id"] = session;
    if (message.method !== "initialize") headers["mcp-protocol-version"] = "2025-06-18";
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
    const next = response.headers.get("mcp-session-id");
    if (next) session = next;
    const body = await response.text();
    if (message.id === undefined) return;
    if (!response.ok) return fail(message.id, "Apollo MCP answered " + response.status + ": " + body.slice(0, 300));
    if ((response.headers.get("content-type") || "").includes("text/event-stream")) {
      for (const line of body.split("\n")) if (line.startsWith("data:") && line.slice(5).trim()) out(JSON.parse(line.slice(5)));
    } else if (body.trim()) out(JSON.parse(body));
  } catch (error) { fail(message.id, String(error && error.message || error)); }
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) { try { void forward(JSON.parse(line)); } catch {} }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

export const bearer = (mcp: McpEndpoint) => `Bearer ${mcp.bearerToken}`;

/** Apollo's MCP server as a stdio command: Node (or Electron as Node) running the bridge above. */
export const mcpStdioCommand = (mcp: McpEndpoint) => ({
  command: process.execPath,
  args: ["-e", MCP_STDIO_BRIDGE],
  env: { ELECTRON_RUN_AS_NODE: "1", APOLLO_MCP_URL: mcp.url, APOLLO_MCP_AUTHORIZATION: bearer(mcp) },
});

/** What a tool call does, in ACP's terms (other protocols map onto these). */
export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

const SAFE: ReadonlySet<ToolKind> = new Set(["read", "search", "think", "fetch", "switch_mode"]);
const WRITES: ReadonlySet<ToolKind> = new Set(["edit", "delete", "move", "execute"]);

/**
 * How a permission request is answered without the user, or `ask` to show it.
 * - Read-only sessions (reflections) refuse anything that writes or runs, allow the rest.
 * - Full access allows everything.
 * - Auto allows reads and edits and asks for commands and unknown tools.
 * - Approval-required asks for anything that is not a plain read.
 */
export const autoDecision = (mode: RuntimeMode, readOnly: boolean, kind: ToolKind): "allow" | "reject" | "ask" => {
  if (readOnly) return WRITES.has(kind) ? "reject" : "allow";
  if (mode === "full-access") return "allow";
  if (SAFE.has(kind)) return "allow";
  if (mode === "auto" && kind === "edit") return "allow";
  return "ask";
};

/** A short title for an approval card. */
export const approvalTitle = (kind: ToolKind, title: string) => {
  switch (kind) {
    case "execute":
      return "Run command?";
    case "edit":
      return "Edit files?";
    case "delete":
      return "Delete files?";
    case "move":
      return "Move files?";
    case "fetch":
      return "Fetch from the web?";
    default:
      return title ? `Allow ${title}?` : "Allow this tool call?";
  }
};
