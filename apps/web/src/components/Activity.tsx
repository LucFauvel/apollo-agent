import {
  AppWindow,
  Bot,
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
import {
  type ActivityBlock,
  type ActivityCategory as Category,
  type ActivityStep as Step,
  activityRunning,
  bySubagent,
  describeStep as describe,
  errorCount,
  firstLine,
  stepCategory,
  summarizeActivity as summarize,
  type ToolStep as Tool,
  stepTitle,
  toolSummary as prettySummary,
} from "@apollo/client";
import { Collapse, cx } from "./ui.tsx";

export { type ActivityBlock, toBlocks, type TranscriptBlock as Block } from "@apollo/client";

/** Each category's icon, and its tint as Tailwind classes. */
const CATEGORY: Record<Category, { icon: LucideIcon; color: string; ring: string }> = {
  thought: { icon: Lightbulb, color: "text-violet-300", ring: "bg-violet-500/10 ring-violet-500/25" },
  agent: { icon: Bot, color: "text-rose-300", ring: "bg-rose-500/10 ring-rose-500/25" },
  command: { icon: SquareTerminal, color: "text-emerald-300", ring: "bg-emerald-500/10 ring-emerald-500/25" },
  read: { icon: FileText, color: "text-sky-300", ring: "bg-sky-500/10 ring-sky-500/25" },
  edit: { icon: FilePen, color: "text-amber-300", ring: "bg-amber-500/10 ring-amber-500/25" },
  search: { icon: Search, color: "text-cyan-300", ring: "bg-cyan-500/10 ring-cyan-500/25" },
  web: { icon: Globe, color: "text-indigo-300", ring: "bg-indigo-500/10 ring-indigo-500/25" },
  browser: { icon: AppWindow, color: "text-orange-300", ring: "bg-orange-500/10 ring-orange-500/25" },
  visual: { icon: LayoutTemplate, color: "text-teal-300", ring: "bg-teal-500/10 ring-teal-500/25" },
  secret: { icon: KeyRound, color: "text-amber-300", ring: "bg-amber-500/10 ring-amber-500/25" },
  apollo: { icon: Network, color: "text-fuchsia-300", ring: "bg-fuchsia-500/10 ring-fuchsia-500/25" },
  git: { icon: GitBranch, color: "text-emerald-300", ring: "bg-emerald-500/10 ring-emerald-500/25" },
  connector: { icon: Plug, color: "text-indigo-300", ring: "bg-indigo-500/10 ring-indigo-500/25" },
  tool: { icon: Wrench, color: "text-zinc-300", ring: "bg-zinc-500/10 ring-zinc-500/25" },
};
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

function StepRow({ step, last, nested }: { step: Step; last: boolean; nested: boolean }) {
  const [open, setOpen] = useState(false);
  const category = stepCategory(step);
  const pending = step.kind === "tool" && step.output === null;
  const error = step.kind === "tool" && step.isError;
  const detail = step.kind === "reasoning" ? step.text : step.output;
  const expandable = Boolean(detail?.trim());

  return (
    <div className={cx("animate-fade-up relative flex gap-2.5", nested && "ml-5")}>
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
              <span className={cx("shrink-0 font-medium", error ? "text-red-300" : "text-zinc-200")}>{stepTitle(step as Tool)}</span>
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
  const running = activityRunning(block, live);
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
            {errorCount(errors)}
          </span>
        ) : null}
        <span className="shrink-0 text-[10px] text-zinc-600 tabular-nums">{steps.length}</span>
        <ChevronRight className={cx("size-3.5 shrink-0 text-zinc-500 transition-transform duration-200", open && "rotate-90")} />
      </button>
      <Collapse open={open}>
        <div className="px-2.5 pt-2.5">
          {steps.map((step, i) => (
            <StepRow key={step.key} step={step} last={i === steps.length - 1} nested={bySubagent(step, steps)} />
          ))}
        </div>
      </Collapse>
    </div>
  );
}
