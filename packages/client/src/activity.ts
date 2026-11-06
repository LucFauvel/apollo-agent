import type { TranscriptItem } from "./transcript.ts";

/**
 * How a conversation's thoughts and tool calls are grouped, named and summarized,
 * shared by the desktop and phone apps so both read the same way. Each app draws the
 * icons and colors for a category itself.
 */

export type ActivityStep = Extract<TranscriptItem, { kind: "tool" | "reasoning" }>;
export type ToolStep = Extract<TranscriptItem, { kind: "tool" }>;

/** A run of consecutive thoughts and tool calls, shown as one collapsible block. */
export interface ActivityBlock {
  readonly kind: "activity";
  readonly key: string;
  readonly steps: ReadonlyArray<ActivityStep>;
}

export type TranscriptBlock = ActivityBlock | Exclude<TranscriptItem, ActivityStep>;

/** Folds consecutive thoughts and tool calls into activity blocks. */
export const toBlocks = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<TranscriptBlock> => {
  const blocks: Array<TranscriptBlock> = [];
  let run: Array<ActivityStep> = [];
  const flush = () => {
    if (run.length > 0) blocks.push({ kind: "activity", key: `a:${run[0]!.key}`, steps: run });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool" || item.kind === "reasoning") run.push(item);
    else {
      flush();
      blocks.push(item);
    }
  }
  flush();
  return blocks;
};

export type ActivityCategory =
  | "thought"
  | "agent"
  | "command"
  | "read"
  | "edit"
  | "search"
  | "web"
  | "browser"
  | "visual"
  | "secret"
  | "apollo"
  | "connector"
  | "git"
  | "tool";

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** How a count of each category reads, and its color (Tailwind's 300 shade of its hue). */
export const ACTIVITY: Record<ActivityCategory, { readonly color: string; readonly phrase: (n: number) => string }> = {
  thought: { color: "#c4b5fd", phrase: (n) => (n === 1 ? "Thought" : `Thought ${n}×`) },
  agent: { color: "#fda4af", phrase: (n) => plural(n, "subagent") },
  command: { color: "#6ee7b7", phrase: (n) => plural(n, "command") },
  read: { color: "#7dd3fc", phrase: (n) => plural(n, "read") },
  edit: { color: "#fcd34d", phrase: (n) => plural(n, "edit") },
  search: { color: "#67e8f9", phrase: (n) => plural(n, "search", "searches") },
  web: { color: "#a5b4fc", phrase: (n) => plural(n, "fetch", "fetches") },
  browser: { color: "#fdba74", phrase: (n) => plural(n, "browser step") },
  visual: { color: "#5eead4", phrase: (n) => plural(n, "visual") },
  secret: { color: "#fcd34d", phrase: (n) => plural(n, "secret request") },
  apollo: { color: "#f0abfc", phrase: (n) => plural(n, "worker action") },
  git: { color: "#6ee7b7", phrase: (n) => plural(n, "git action") },
  connector: { color: "#a5b4fc", phrase: (n) => plural(n, "connector call") },
  tool: { color: "#d4d4d8", phrase: (n) => plural(n, "tool call") },
};

export const errorCount = (n: number) => plural(n, "error");

/**
 * A claude.ai connector tool: `mcp__claude_ai_Slack__slack_send_message` → Slack, "send message".
 * Connector names use `_` for spaces; tool names often repeat the service as a prefix.
 */
const connectorCall = (name: string) => {
  const match = /^mcp__claude_ai_(.+?)__(.+)$/.exec(name);
  if (!match) return null;
  const connector = match[1]!.replace(/_/g, " ");
  const prefix = connector.split(" ")[0]!.toLowerCase();
  const tool = match[2]!
    .replace(new RegExp(`^${prefix.replace(/[^a-z0-9]/g, "")}[-_]`, "i"), "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toLowerCase();
  return { connector, tool };
};

const ORDER: ReadonlyArray<ActivityCategory> = [
  "thought",
  "agent",
  "browser",
  "visual",
  "secret",
  "apollo",
  "git",
  "connector",
  "command",
  "read",
  "search",
  "edit",
  "web",
  "tool",
];

export const toolCategory = (name: string): ActivityCategory => {
  if (name === "Agent" || name === "Task") return "agent";
  const n = name.toLowerCase();
  if (/(^|__)apollo_browser_/.test(n)) return "browser";
  if (/(^|__)apollo_(show|preview)_html$/.test(n)) return "visual";
  if (/(^|__)apollo_request_secret$/.test(n)) return "secret";
  if (/(^|__)apollo_job_/.test(n)) return "command";
  if (/(^|__)apollo_(pr|worktree)_/.test(n)) return "git";
  if (n.startsWith("mcp__apollo__") || n.startsWith("apollo_")) return "apollo";
  if (n.startsWith("mcp__claude_ai_")) return "connector";
  if (/bash|shell|exec|command|terminal/.test(n)) return "command";
  if (/edit|write|patch|apply|notebook/.test(n)) return "edit";
  if (/grep|glob|search|find/.test(n)) return "search";
  if (/web|fetch|http|browser|url/.test(n)) return "web";
  if (/read|view|^ls$|list_dir|open_file/.test(n)) return "read";
  return "tool";
};

export const stepCategory = (step: ActivityStep): ActivityCategory =>
  step.kind === "reasoning" ? "thought" : toolCategory(step.name);

/** A tool's name as people read it: `mcp__apollo__apollo_browser_open` → "browser open". */
export const toolName = (name: string) => {
  const connector = connectorCall(name);
  if (connector) return `${connector.connector} · ${connector.tool}`;
  return (
    name
      .replace(/^mcp__apollo__/, "")
      .replace(/^apollo_browser_(\w+)$/, (_, action: string) => `browser ${action.replace(/_/g, " ")}`)
      // Other Apollo tools read as words: apollo_request_secret → "request secret".
      .replace(/^apollo_(\w+)$/, (_, rest: string) => rest.replace(/_/g, " "))
      .replace(/^mcp__(.+?)__/, (_, server: string) => `${server.replace(/_/g, " ")} · `)
  );
};

/**
 * Tool inputs often arrive as JSON. Browser steps read as a phrase
 * (`type "Ada" → e1`); other JSON becomes `value · value`; `{}` disappears.
 */
export const toolSummary = (name: string, summary: string): string => {
  const text = summary.trim();
  if (!text.startsWith("{")) return text;
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(text);
  } catch {
    return text;
  }
  const str = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const action = /apollo_browser_(\w+)$/.exec(name)?.[1];
  const target = input.ref ?? input.selector;
  switch (action) {
    case "act": {
      const parts = [str(input.action)];
      if (input.text !== undefined) parts.push(JSON.stringify(input.text));
      if (input.secretRef !== undefined) parts.push("a secret");
      if (input.key !== undefined) parts.push(str(input.key));
      if (Array.isArray(input.values)) parts.push(input.values.map(str).join(", "));
      if (input.deltaY !== undefined) parts.push(`${str(input.deltaY)}px`);
      if (target !== undefined) parts.push(`→ ${str(target)}`);
      return parts.join(" ");
    }
    case "open":
    case "navigate":
      return str(input.url ?? input.history ?? "");
    case "wait_for":
      return [input.text && `"${str(input.text)}"`, input.selector, input.urlIncludes].filter(Boolean).map(str).join(" · ");
    case "evaluate":
      return str(input.expression ?? "").replace(/\s+/g, " ");
    case "screenshot":
      return input.fullPage ? "full page" : "";
  }
  // Visuals and secret requests: show what they are about, not their payload.
  if (/apollo_(show|preview)_html$/.test(name)) return str(input.title ?? (input.width ? `${str(input.width)}px` : ""));
  if (/apollo_request_secret$/.test(name)) return str(input.label ?? "");
  return Object.values(input)
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map(str)
    .join(" · ");
};

/**
 * Whether a subagent made this step, and the call that started it is in the same block
 * (then the step is drawn under it). A background subagent's calls can come after the
 * reply, in a block of their own.
 */
export const bySubagent = (step: ActivityStep, steps: ReadonlyArray<ActivityStep>) =>
  step.kind === "tool" && step.parent !== undefined && steps.some((s) => s.key === step.parent);

/** A tool's name as a heading: a subagent call reads as "Subagent". */
export const stepTitle = (step: ToolStep) => (toolCategory(step.name) === "agent" ? "Subagent" : toolName(step.name));

/** A thought's first line, without markdown markers, for its collapsed row. */
export const firstLine = (text: string) =>
  text
    .trim()
    .split("\n")
    .find((l) => l.trim())
    ?.replace(/^[#*>\-\s]+/, "") ?? "";

/** "Thought · 2 commands · 3 reads", and the categories in that order. */
export const summarizeActivity = (steps: ReadonlyArray<ActivityStep>) => {
  const counts = new Map<ActivityCategory, number>();
  for (const step of steps) counts.set(stepCategory(step), (counts.get(stepCategory(step)) ?? 0) + 1);
  const categories = ORDER.filter((c) => counts.has(c));
  return { text: categories.map((c) => ACTIVITY[c].phrase(counts.get(c)!)).join(" · "), categories };
};

/** The last words of a thought being streamed, for the one-line summary. */
const thoughtTail = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `…${flat.slice(-90)}` : flat || "…";
};

/** What a step is doing, for the live line of a running block. */
export const describeStep = (step: ActivityStep) =>
  step.kind === "reasoning"
    ? step.streaming
      ? `Thinking: ${thoughtTail(step.text)}`
      : "Thinking"
    : `${step.kind === "tool" && step.parent ? "Subagent: " : ""}${stepTitle(step)} ${toolSummary(step.name, step.summary)}`.trim();

/** Whether a block is still being worked on: the last one of a busy session, or a tool waiting on output. */
export const activityRunning = (block: ActivityBlock, live: boolean) =>
  live || block.steps.some((s) => s.kind === "tool" && s.output === null);

/** A message from the orchestrator or Apollo: its first line, and the rest. */
export const systemMessageParts = (text: string) => {
  const [first = "", ...rest] = text.replace(/^\[Apollo\]\s*/, "").split("\n");
  return { first, body: rest.join("\n").trim() };
};

/**
 * Whether the "Working…" row shows: the agent is busy, but nothing it is doing is on
 * screen yet (between the user's message and the first output, or between steps).
 */
export const showWorking = (busy: boolean, waitingApproval: boolean, last: TranscriptBlock | undefined) =>
  busy &&
  !waitingApproval &&
  (last === undefined ||
    last.kind === "user" ||
    (last.kind === "assistant" && !last.streaming) ||
    last.kind === "turn-end" ||
    last.kind === "notice");
