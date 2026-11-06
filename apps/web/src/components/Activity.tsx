import {
  AppWindow,
  ChevronRight,
  FilePen,
  FileText,
  GitBranch,
  KeyRound,
  LayoutTemplate,
  Globe,
  Lightbulb,
  Loader2,
  type LucideIcon,
  Network,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";
import type { TranscriptItem } from "../transcript.ts";
import { Collapse, cx } from "./ui.tsx";

type Step = Extract<TranscriptItem, { kind: "tool" | "reasoning" }>;
type Tool = Extract<TranscriptItem, { kind: "tool" }>;

/** A run of consecutive thoughts and tool calls, shown as one collapsible block. */
export interface ActivityBlock {
  readonly kind: "activity";
  readonly key: string;
  readonly steps: ReadonlyArray<Step>;
}

export type Block = ActivityBlock | Exclude<TranscriptItem, Step>;

/** Folds consecutive thoughts and tool calls into activity blocks. */
export const toBlocks = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<Block> => {
  const blocks: Array<Block> = [];
  let run: Array<Step> = [];
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

// ---------------------------------------------------------------------------
// Step categories: icon, colour and how a count of them reads.
// ---------------------------------------------------------------------------

type Category =
  | "thought"
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

const CATEGORY: Record<Category, { icon: LucideIcon; color: string; ring: string; phrase: (n: number) => string }> = {
  thought: { icon: Lightbulb, color: "text-violet-300", ring: "bg-violet-500/10 ring-violet-500/25", phrase: (n) => (n === 1 ? "Thought" : `Thought ${n}×`) },
  command: { icon: SquareTerminal, color: "text-emerald-300", ring: "bg-emerald-500/10 ring-emerald-500/25", phrase: (n) => plural(n, "command") },
  read: { icon: FileText, color: "text-sky-300", ring: "bg-sky-500/10 ring-sky-500/25", phrase: (n) => plural(n, "read") },
  edit: { icon: FilePen, color: "text-amber-300", ring: "bg-amber-500/10 ring-amber-500/25", phrase: (n) => plural(n, "edit") },
  search: { icon: Search, color: "text-cyan-300", ring: "bg-cyan-500/10 ring-cyan-500/25", phrase: (n) => plural(n, "search", "searches") },
  web: { icon: Globe, color: "text-indigo-300", ring: "bg-indigo-500/10 ring-indigo-500/25", phrase: (n) => plural(n, "fetch", "fetches") },
  browser: { icon: AppWindow, color: "text-orange-300", ring: "bg-orange-500/10 ring-orange-500/25", phrase: (n) => plural(n, "browser step") },
  visual: { icon: LayoutTemplate, color: "text-teal-300", ring: "bg-teal-500/10 ring-teal-500/25", phrase: (n) => plural(n, "visual") },
  secret: { icon: KeyRound, color: "text-amber-300", ring: "bg-amber-500/10 ring-amber-500/25", phrase: (n) => plural(n, "secret request") },
  apollo: { icon: Network, color: "text-fuchsia-300", ring: "bg-fuchsia-500/10 ring-fuchsia-500/25", phrase: (n) => plural(n, "worker action") },
  git: { icon: GitBranch, color: "text-emerald-300", ring: "bg-emerald-500/10 ring-emerald-500/25", phrase: (n) => plural(n, "git action") },
  connector: { icon: Plug, color: "text-indigo-300", ring: "bg-indigo-500/10 ring-indigo-500/25", phrase: (n) => plural(n, "connector call") },
  tool: { icon: Wrench, color: "text-zinc-300", ring: "bg-zinc-500/10 ring-zinc-500/25", phrase: (n) => plural(n, "tool call") },
};

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

const ORDER: ReadonlyArray<Category> = ["thought", "browser", "visual", "secret", "apollo", "command", "read", "search", "edit", "web", "tool"];

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

const toolCategory = (name: string): Category => {
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

const stepCategory = (step: Step): Category => (step.kind === "reasoning" ? "thought" : toolCategory(step.name));

const toolName = (name: string) => {
  const connector = connectorCall(name);
  if (connector) return `${connector.connector} · ${connector.tool}`;
  return name
    .replace(/^mcp__apollo__/, "")
    .replace(/^apollo_browser_(\w+)$/, (_, action: string) => `browser ${action.replace(/_/g, " ")}`)
    // Other Apollo tools read as words: apollo_request_secret → "request secret".
    .replace(/^apollo_(\w+)$/, (_, rest: string) => rest.replace(/_/g, " "))
    .replace(/^mcp__(.+?)__/, (_, server: string) => `${server.replace(/_/g, " ")} · `);
};

/**
 * Tool inputs often arrive as JSON. Browser steps read as a phrase
 * (`type "Ada" → e1`); other JSON becomes `value · value`; `{}` disappears.
 */
const prettySummary = (name: string, summary: string): string => {
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

const firstLine = (text: string) => text.trim().split("\n").find((l) => l.trim())?.replace(/^[#*>\-\s]+/, "") ?? "";

/** "Thought · 2 commands · 3 reads". */
const summarize = (steps: ReadonlyArray<Step>) => {
  const counts = new Map<Category, number>();
  for (const step of steps) counts.set(stepCategory(step), (counts.get(stepCategory(step)) ?? 0) + 1);
  const parts = ORDER.filter((c) => counts.has(c)).map((c) => CATEGORY[c].phrase(counts.get(c)!));
  return { text: parts.join(" · "), categories: ORDER.filter((c) => counts.has(c)) };
};

/** What a step is doing, for the live line of a running block. */
/** The last words of a thought being streamed, for the one-line summary. */
const thoughtTail = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `…${flat.slice(-90)}` : flat || "…";
};

const describe = (step: Step) =>
  step.kind === "reasoning"
    ? step.streaming
      ? `Thinking: ${thoughtTail(step.text)}`
      : "Thinking"
    : `${toolName(step.name)} ${prettySummary(step.name, step.summary)}`.trim();

function StepIcon({ category, pending = false, error = false }: { category: Category; pending?: boolean; error?: boolean }) {
  const { icon: Icon, color, ring } = CATEGORY[category];
  return (
    <span
      className={cx(
        "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
        error ? "bg-red-500/10 text-red-300 ring-red-500/30" : cx(ring, color),
      )}
    >
      {pending ? <Loader2 className="size-3 animate-spin" /> : error ? <X className="size-3" /> : <Icon className="size-3" strokeWidth={2} />}
    </span>
  );
}

function StepRow({ step, last }: { step: Step; last: boolean }) {
  const [open, setOpen] = useState(false);
  const category = stepCategory(step);
  const pending = step.kind === "tool" && step.output === null;
  const error = step.kind === "tool" && step.isError;
  const detail = step.kind === "reasoning" ? step.text : step.output;
  const expandable = Boolean(detail?.trim());

  return (
    <div className="animate-fade-up relative flex gap-2.5">
      {!last ? <span className="absolute top-6 bottom-0 left-3 w-px -translate-x-1/2 bg-zinc-800" /> : null}
      <StepIcon category={category} pending={pending} error={error} />
      <div className="min-w-0 flex-1 pb-2">
        <button
          type="button"
          disabled={!expandable}
          onClick={() => setOpen(!open)}
          className="group flex h-6 w-full min-w-0 items-center gap-2 rounded-md text-left text-xs enabled:cursor-pointer"
        >
          {step.kind === "reasoning" ? (
            <>
              <span className="shrink-0 font-medium text-violet-200/90">Thought</span>
              {!open ? <span className="min-w-0 flex-1 truncate text-zinc-500 italic">{firstLine(step.text)}</span> : <span className="flex-1" />}
            </>
          ) : (
            <>
              <span className={cx("shrink-0 font-medium", error ? "text-red-300" : "text-zinc-200")}>{toolName((step as Tool).name)}</span>
              <span className={cx("min-w-0 flex-1 truncate font-mono text-[11px]", pending ? "shimmer-text" : "text-zinc-500")}>
                {prettySummary((step as Tool).name, (step as Tool).summary)}
              </span>
            </>
          )}
          {expandable ? (
            <ChevronRight
              className={cx(
                "size-3.5 shrink-0 text-zinc-600 transition-transform duration-200 group-hover:text-zinc-300",
                open && "rotate-90",
              )}
            />
          ) : null}
        </button>
        <Collapse open={open}>
          {step.kind === "reasoning" ? (
            <div className="mt-1 border-l-2 border-violet-500/20 pl-3 text-xs leading-relaxed whitespace-pre-wrap text-zinc-400 italic">
              {step.text}
            </div>
          ) : (
            <pre
              className={cx(
                "mt-1 max-h-72 overflow-auto rounded-lg border px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap",
                error ? "border-red-900/50 bg-red-950/20 text-red-200/80" : "border-zinc-800 bg-zinc-900/60 text-zinc-400",
              )}
            >
              {detail}
            </pre>
          )}
        </Collapse>
      </div>
    </div>
  );
}

/**
 * Thoughts and tool calls between two messages. Collapsed to a one-line
 * summary; while the agent is still in it, the line shows the current step.
 */
export function ActivityGroup({ block, live }: { block: ActivityBlock; live: boolean }) {
  const [open, setOpen] = useState(false);
  const { steps } = block;
  const { text, categories } = summarize(steps);
  const running = live || steps.some((s) => s.kind === "tool" && s.output === null);
  const errors = steps.filter((s) => s.kind === "tool" && s.isError).length;
  const current = steps.at(-1)!;

  return (
    <div className="animate-fade-up">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cx(
          "group flex w-full min-w-0 items-center gap-2.5 rounded-xl border px-2.5 py-1.5 text-left text-xs transition-colors duration-200",
          open ? "border-zinc-800 bg-zinc-900/60" : "border-transparent hover:border-zinc-800/80 hover:bg-zinc-900/40",
        )}
      >
        <span className="flex shrink-0 -space-x-1.5">
          {categories.slice(0, 4).map((c) => {
            const { icon: Icon, color } = CATEGORY[c];
            return (
              <span key={c} className={cx("flex size-5 items-center justify-center rounded-full bg-zinc-900 ring-2 ring-zinc-950", color)}>
                <Icon className="size-3" strokeWidth={2} />
              </span>
            );
          })}
        </span>
        {running && !open ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <Loader2 className="size-3 shrink-0 animate-spin text-zinc-400" />
            <span className="shimmer-text min-w-0 truncate">{describe(current)}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-zinc-400 group-hover:text-zinc-300">{text}</span>
        )}
        {errors > 0 ? (
          <span className="shrink-0 rounded-md bg-red-500/15 px-1.5 py-px text-[10px] font-medium text-red-300">
            {plural(errors, "error")}
          </span>
        ) : null}
        <span className="shrink-0 text-[10px] text-zinc-600 tabular-nums">{steps.length}</span>
        <ChevronRight className={cx("size-3.5 shrink-0 text-zinc-500 transition-transform duration-200", open && "rotate-90")} />
      </button>
      <Collapse open={open}>
        <div className="px-2.5 pt-2.5">
          {steps.map((step, i) => (
            <StepRow key={step.key} step={step} last={i === steps.length - 1} />
          ))}
        </div>
      </Collapse>
    </div>
  );
}
