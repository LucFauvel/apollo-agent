import { blockTime, type TranscriptBlock } from "@apollo/client";
import { ChevronRight } from "lucide-react";
import { cx } from "./ui.tsx";

/**
 * Long conversations, folded by day: a divider per day, earlier days collapsed. And the
 * time of a message, shown on hover.
 */

const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

const dayLabel = (at: number) => {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(at) === dayKey(today.getTime())) return "Today";
  if (dayKey(at) === dayKey(yesterday.getTime())) return "Yesterday";
  const d = new Date(at);
  return d.toLocaleDateString([], {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
};

export interface DayGroup {
  readonly key: string;
  readonly label: string;
  /** The day's blocks, with their position in the whole conversation. */
  readonly blocks: ReadonlyArray<{ readonly block: TranscriptBlock; readonly index: number }>;
}

/** Blocks by local day; a block without a time stays with the one before it. */
export const groupByDay = (blocks: ReadonlyArray<TranscriptBlock>): Array<DayGroup> => {
  const groups: Array<{ key: string; label: string; blocks: Array<{ block: TranscriptBlock; index: number }> }> = [];
  blocks.forEach((block, index) => {
    const at = blockTime(block);
    const key = at === undefined ? (groups.at(-1)?.key ?? "unknown") : dayKey(at);
    const last = groups.at(-1);
    if (last && last.key === key) last.blocks.push({ block, index });
    else groups.push({ key, label: at === undefined ? "Earlier" : dayLabel(at), blocks: [{ block, index }] });
  });
  return groups;
};

/** Messages and steps, for a folded day's count. */
const countOf = (group: DayGroup) =>
  group.blocks.filter(({ block }) => block.kind === "user" || block.kind === "assistant").length;

export function DayDivider({ group, open, onToggle }: { group: DayGroup; open: boolean; onToggle: () => void }) {
  const messages = countOf(group);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="group sticky top-0 z-10 -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-3 bg-zinc-950/90 px-1 py-2 text-[11px] backdrop-blur"
    >
      <span className="h-px flex-1 bg-zinc-800 transition-colors group-hover:bg-zinc-700" />
      <span className="flex items-center gap-1.5 font-medium text-zinc-400 transition-colors group-hover:text-zinc-200">
        <ChevronRight className={cx("size-3 transition-transform duration-200", open && "rotate-90")} />
        {group.label}
        {!open ? (
          <span className="font-normal text-zinc-600">
            · {messages} {messages === 1 ? "message" : "messages"}
          </span>
        ) : null}
      </span>
      <span className="h-px flex-1 bg-zinc-800 transition-colors group-hover:bg-zinc-700" />
    </button>
  );
}

/** A message's time, shown when the pointer is over the message (the date too, if not today). */
export function MessageTime({ at, className }: { at: number | undefined; className?: string }) {
  if (at === undefined) return null;
  const d = new Date(at);
  const today = dayKey(at) === dayKey(Date.now());
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <time
      dateTime={d.toISOString()}
      title={d.toLocaleString()}
      className={cx("shrink-0 text-[10.5px] text-zinc-600 tabular-nums opacity-0 transition-opacity group-hover:opacity-100", className)}
    >
      {today ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`}
    </time>
  );
}
