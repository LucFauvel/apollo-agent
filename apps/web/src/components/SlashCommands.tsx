import type { Session, SlashCommand } from "@apollo/contracts";
import { Loader2, Slash, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../rpc.ts";
import { cx, Tooltip } from "./ui.tsx";

/** `/name args` → its parts; `null` when the text is not a command. */
export const parseCommand = (text: string) => {
  const match = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!, args: (match[2] ?? "").trim() } : null;
};

/** Apollo's own commands (the server handles them): shown at once, before the harness's arrive. */
const APOLLO_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: "compact", description: "Summarize the conversation so far to free context", argumentHint: "[what to keep]", source: "apollo" },
  { name: "clear", description: "Start a fresh conversation in this session (memory and skills stay)", argumentHint: "", source: "apollo" },
  { name: "stop", description: "Stop the current turn", argumentHint: "", source: "apollo" },
  { name: "reflect", description: "Save what this session learned to memory now", argumentHint: "", source: "apollo" },
];

/**
 * The session's slash commands. Apollo's are known up front; the harness's (Claude Code
 * custom commands, skills) load the first time the user types `/`, which opens the
 * session's process if needed (no tokens, but it can take a few seconds).
 */
export function useSlashCommands(session: Session, text: string) {
  const [commands, setCommands] = useState<ReadonlyArray<SlashCommand> | null>(null);
  const [selected, setSelected] = useState(0);
  const requested = useRef(false);
  const typing = /^\/[\w:.-]*$/.test(text);

  useEffect(() => {
    if (!typing || requested.current) return;
    requested.current = true;
    rpc((c) => c["sessions.commands"]({ sessionId: session.id }))
      .then(setCommands)
      .catch(() => {
        requested.current = false;
      });
  }, [typing, session.id]);

  const query = typing ? text.slice(1).toLowerCase() : "";
  const all = commands ?? APOLLO_COMMANDS;
  const matches = useMemo(
    () =>
      typing
        ? all
            .filter((c) => c.name.toLowerCase().includes(query))
            .sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)))
            .slice(0, 8)
        : [],
    [typing, all, query],
  );
  useEffect(() => setSelected(0), [query]);

  return {
    open: typing && (matches.length > 0 || commands === null),
    loading: typing && commands === null,
    matches,
    selected: Math.min(selected, Math.max(matches.length - 1, 0)),
    move: (delta: number) => setSelected((i) => (matches.length ? (i + delta + matches.length) % matches.length : 0)),
  };
}

/** The menu above the message box while a command is being typed. */
export function SlashMenu({
  matches,
  selected,
  loading,
  onPick,
}: {
  matches: ReadonlyArray<SlashCommand>;
  selected: number;
  loading: boolean;
  onPick: (command: SlashCommand) => void;
}) {
  return (
    <div
      role="listbox"
      className="animate-pop-in absolute right-0 bottom-full left-0 z-20 mb-2 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/95 p-1 shadow-2xl shadow-black/50 backdrop-blur"
    >
      {matches.map((c, i) => (
        <button
          key={`${c.source}:${c.name}`}
          type="button"
          role="option"
          aria-selected={i === selected}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
          className={cx(
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
            i === selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-900",
          )}
        >
          {c.source === "apollo" ? (
            <Slash className="size-3.5 shrink-0 text-sky-300" />
          ) : (
            <TerminalSquare className="size-3.5 shrink-0 text-zinc-500" />
          )}
          <span className="shrink-0 font-mono text-zinc-100">/{c.name}</span>
          {c.argumentHint ? <span className="shrink-0 font-mono text-[11px] text-zinc-600">{c.argumentHint}</span> : null}
          <span className="min-w-0 flex-1 truncate text-zinc-500">{c.description}</span>
        </button>
      ))}
      {loading ? (
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-zinc-600">
          <Loader2 className="size-3 animate-spin" /> Loading the agent's own commands…
        </div>
      ) : null}
    </div>
  );
}

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** How full the context window is: a small ring and a percentage, with a tooltip. */
export function ContextMeter({ context }: { context: NonNullable<Session["context"]> }) {
  const ratio = Math.min(context.used / context.window, 1);
  const percent = Math.round(ratio * 100);
  const color = ratio >= 0.9 ? "text-red-400" : ratio >= 0.7 ? "text-amber-300" : "text-zinc-500";
  const r = 6;
  const circumference = 2 * Math.PI * r;
  return (
    <Tooltip
      align="end"
      content={
        <>
          <span className="block font-medium text-zinc-100">Context {percent}% full</span>
          {tokens(context.used)} of {tokens(context.window)} tokens. The agent compacts the conversation automatically when it
          gets close to full; type /compact to do it now.
        </>
      }
    >
      <span className={cx("flex items-center gap-1 px-1 text-[11px] tabular-nums", color)} aria-label={`Context ${percent}% full`}>
        <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
          <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity=".2" strokeWidth="2" />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${circumference * ratio} ${circumference}`}
            className="transition-[stroke-dasharray] duration-500"
          />
        </svg>
        {percent}%
      </span>
    </Tooltip>
  );
}
