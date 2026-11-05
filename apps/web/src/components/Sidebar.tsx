import type { Bot, Session, SessionId } from "@apollo/contracts";
import { useApp } from "../store.ts";
import { Button, cx, ProviderBadge, StatusDot } from "./ui.tsx";

const roleOrder = { main: 0, worker: 1, reflection: 2 } as const;

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: Session;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cx(
        "group flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-7 text-left text-[13px]",
        selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
      )}
    >
      <StatusDot status={session.status} />
      <span className={cx("min-w-0 flex-1 truncate", session.role === "reflection" && "italic opacity-70")}>
        {session.role === "reflection" ? "✦ " : ""}
        {session.title}
      </span>
      <ProviderBadge provider={session.provider} />
    </button>
  );
}

function BotGroup({
  bot,
  sessions,
  selectedId,
  onSelect,
  onNewSession,
}: {
  bot: Bot;
  sessions: ReadonlyArray<Session>;
  selectedId: SessionId | null;
  onSelect: (id: SessionId) => void;
  onNewSession: (bot: Bot) => void;
}) {
  const main = sessions.find((s) => s.id === bot.mainSessionId);
  const children = sessions
    .filter((s) => s.id !== bot.mainSessionId)
    .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || b.createdAt - a.createdAt);
  const busy = children.filter((s) => s.status === "running" || s.status === "waiting-approval").length;

  return (
    <div className="space-y-0.5">
      <div
        className={cx(
          "group flex items-center gap-2 rounded-md px-2 py-1.5",
          selectedId === bot.mainSessionId ? "bg-zinc-800" : "hover:bg-zinc-900",
        )}
      >
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onSelect(bot.mainSessionId)}>
          <span className="flex size-5 shrink-0 items-center justify-center rounded bg-zinc-100 text-[11px] font-bold text-zinc-900">
            {bot.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">{bot.name}</span>
          {main ? <StatusDot status={main.status} /> : null}
          {busy > 0 ? <span className="text-[10px] text-emerald-400">{busy} running</span> : null}
        </button>
        <button
          className="text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-zinc-200"
          title="New session"
          onClick={() => onNewSession(bot)}
        >
          +
        </button>
      </div>
      {children.map((s) => (
        <SessionRow key={s.id} session={s} selected={selectedId === s.id} onSelect={() => onSelect(s.id)} />
      ))}
    </div>
  );
}

export function Sidebar({
  selectedId,
  onSelect,
  onNewBot,
  onNewSession,
  onDevices,
}: {
  selectedId: SessionId | null;
  onSelect: (id: SessionId) => void;
  onNewBot: () => void;
  onNewSession: (bot: Bot) => void;
  onDevices: () => void;
}) {
  const bots = useApp((s) => s.bots);
  const sessions = useApp((s) => s.sessions);
  const connected = useApp((s) => s.connected);
  const allSessions = [...sessions.values()];

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950">
      <div className="flex h-12 items-center justify-between border-b border-zinc-800/80 px-3">
        <span className="text-sm font-semibold tracking-wide text-zinc-100">Apollo</span>
        <Button size="sm" variant="ghost" onClick={onNewBot}>
          + Bot
        </Button>
      </div>
      <nav className="flex-1 space-y-3 overflow-y-auto p-2">
        {[...bots.values()].map((bot) => (
          <BotGroup
            key={bot.id}
            bot={bot}
            sessions={allSessions.filter((s) => s.botId === bot.id)}
            selectedId={selectedId}
            onSelect={onSelect}
            onNewSession={onNewSession}
          />
        ))}
        {bots.size === 0 && connected ? (
          <p className="px-2 py-4 text-xs text-zinc-500">No bots yet. Create one to get started.</p>
        ) : null}
      </nav>
      <div className="flex items-center gap-2 border-t border-zinc-800/80 px-3 py-2 text-[11px] text-zinc-500">
        <span className={cx("size-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-amber-500 animate-pulse")} />
        {connected ? "Connected" : "Connecting…"}
        <button className="ml-auto hover:text-zinc-200" onClick={onDevices}>
          Devices
        </button>
      </div>
    </aside>
  );
}
