import type { Bot, BotId } from "@apollo/contracts";
import { AtSign, ChevronDown } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useApp } from "../store.ts";
import { MarkdownText } from "./Code.tsx";
import { BotAvatar } from "./Sidebar.tsx";
import { Collapse, cx } from "./ui.tsx";

/**
 * Tagging another bot with `@Name` tells the current bot who the user means (nothing is
 * sent to the tagged bot). Bots write to each other with apollo_ask_bot; their answers show
 * as `peer` messages. These are the composer's picker and how tags and answers look.
 */

/** The `@word` being typed just before the caret, if any. */
const typedMention = (text: string, caret: number) => {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? { query: match[1]!, start: caret - match[1]!.length - 1 } : null;
};

/** The other bots the user can tag from this conversation, matching what they type after `@`. */
export const useMentions = (ownBotId: BotId, text: string, caret: number) => {
  const bots = useApp((s) => s.bots);
  const [selected, setSelected] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const typed = typedMention(text, caret);
  const matches = useMemo(() => {
    if (!typed) return [];
    const q = typed.query.toLowerCase();
    return [...bots.values()]
      .filter((b) => b.id !== ownBotId && b.name.toLowerCase().startsWith(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 6);
  }, [bots, ownBotId, typed?.query]);
  const open = typed !== null && matches.length > 0 && dismissedAt !== text;
  const index = Math.min(selected, Math.max(0, matches.length - 1));
  return {
    open,
    matches,
    selected: index,
    move: (delta: number) => setSelected((index + delta + matches.length) % matches.length),
    dismiss: () => setDismissedAt(text),
    /** The text with the typed `@word` replaced by the bot's name, and where the caret goes. */
    complete: (bot: Bot) => {
      const start = typed?.start ?? caret;
      const before = text.slice(0, start);
      const after = text.slice(caret).replace(/^\S*/, "");
      const inserted = `@${bot.name} `;
      setSelected(0);
      return { text: `${before}${inserted}${after.replace(/^ /, "")}`, caret: before.length + inserted.length };
    },
  };
};

export function MentionMenu({
  matches,
  selected,
  onPick,
}: {
  matches: ReadonlyArray<Bot>;
  selected: number;
  onPick: (bot: Bot) => void;
}) {
  return (
    <div
      role="listbox"
      className="animate-pop-in absolute right-0 bottom-full left-0 z-20 mb-2 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/95 p-1 shadow-2xl shadow-black/50 backdrop-blur"
    >
      <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-[10.5px] font-medium tracking-wide text-zinc-500 uppercase">
        <AtSign className="size-3" /> Tag another bot
      </div>
      {matches.map((bot, i) => (
        <button
          key={bot.id}
          type="button"
          role="option"
          aria-selected={i === selected}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(bot);
          }}
          className={cx(
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
            i === selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-900",
          )}
        >
          <BotAvatar avatar={bot.avatar} size="sm" />
          <span className="shrink-0 font-medium text-zinc-100">{bot.name}</span>
          <span className="min-w-0 flex-1 truncate text-zinc-500">
            {bot.instructions.trim() ? bot.instructions.trim().split("\n")[0] : "Another of your bots"}
          </span>
        </button>
      ))}
    </div>
  );
}

/** The user's text with `@BotName` tags highlighted. */
export function WithMentions({ text }: { text: string }) {
  const bots = useApp((s) => s.bots);
  const names = useMemo(
    () => [...bots.values()].map((b) => b.name).sort((a, b) => b.length - a.length),
    [bots],
  );
  if (names.length === 0 || !text.includes("@")) return <>{text}</>;
  const pattern = new RegExp(`(^|[^\\w@])(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}))(?![\\w-])`, "gi");
  const parts: Array<ReactNode> = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index! + match[1]!.length;
    parts.push(text.slice(last, start));
    parts.push(
      <span key={start} className="rounded bg-violet-500/20 px-1 font-medium text-violet-200">
        {match[2]}
      </span>,
    );
    last = start + match[2]!.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/** A message from another of the user's bots: collapsed to its first line, opened on click. */
export function PeerMessage({ botId, text }: { botId: string | undefined; text: string }) {
  const bot = useApp((s) => (botId ? s.bots.get(botId as BotId) : undefined));
  const [open, setOpen] = useState(false);
  const first = text.trim().split("\n").find((l) => l.trim())?.replace(/^[#*>\-\s]+/, "") ?? "";
  return (
    <div className="animate-fade-up overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-zinc-900/60"
      >
        {bot ? <BotAvatar avatar={bot.avatar} size="sm" /> : null}
        <span className="shrink-0 text-xs font-semibold text-zinc-200">{bot?.name ?? "Another bot"}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{open ? "" : first}</span>
        <ChevronDown className={cx("size-3.5 shrink-0 text-zinc-500 transition-transform duration-200", open && "rotate-180")} />
      </button>
      <Collapse open={open}>
        <div className="markdown border-t border-zinc-800/80 px-3.5 py-2.5 text-sm leading-relaxed text-zinc-200">
          <MarkdownText>{text}</MarkdownText>
        </div>
      </Collapse>
    </div>
  );
}
