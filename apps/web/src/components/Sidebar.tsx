import type { Bot, BotAvatar as BotAvatarValue, Session, SessionId } from "@apollo/contracts";
import { BlobAvatar } from "./BlobAvatar.tsx";
import { Archive, Blocks, ChevronRight, MonitorSmartphone, Pause, Plus, Settings, Settings2, Sparkles, SquarePen } from "lucide-react";
import { useState } from "react";
import { formatUsage, usageTitle } from "../format.ts";
import { useApp } from "../store.ts";
import { useProviderVersions } from "../versions.ts";
import { ApolloMark, ProviderLogo } from "./icons.tsx";
import { Collapse, cx, IconButton, providerName, StatusDot, statusLabel } from "./ui.tsx";

const roleOrder = { main: 0, worker: 1, reflection: 2 } as const;

export function BotAvatar({ avatar, size = "md" }: { avatar: BotAvatarValue; size?: "sm" | "md" | "lg" }) {
  return <BlobAvatar avatar={avatar} size={size} />;
}

const workerCount = (sessions: ReadonlyArray<Session>) => {
  const n = sessions.filter((s) => s.role === "worker").length;
  return n === 0 ? "No workers" : n === 1 ? "1 worker" : `${n} workers`;
};

const isBusy = (s: Session) => s.status === "running" || s.status === "waiting-approval" || s.status === "starting";

/**
 * A worker that did its work and is not doing anything now. It retires to the
 * Finished section and comes back up as soon as it works again; the open session
 * stays in place until you leave it.
 */
const isFinished = (s: Session, selectedId: SessionId | null) =>
  s.role === "worker" && !isBusy(s) && s.completedTurns > 0 && s.id !== selectedId;

const FINISHED_OPEN_KEY = "apollo.sidebar.finishedOpen";
const readFinishedOpen = () => {
  try {
    return localStorage.getItem(FINISHED_OPEN_KEY) === "1";
  } catch {
    return false;
  }
};

const ago = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

/** Finished worker sessions of every bot, collapsed at the bottom of the sidebar. */
function FinishedSection({
  sessions,
  bots,
  selectedId,
  onSelect,
}: {
  sessions: ReadonlyArray<Session>;
  bots: ReadonlyMap<string, Bot>;
  selectedId: SessionId | null;
  onSelect: (id: SessionId) => void;
}) {
  const [open, setOpen] = useState(readFinishedOpen);
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(FINISHED_OPEN_KEY, open ? "0" : "1");
    } catch {}
  };
  if (sessions.length === 0) return null;
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="shrink-0 border-t border-zinc-800/80 px-2 py-1.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase transition-colors hover:text-zinc-400"
      >
        <ChevronRight className={cx("size-3 transition-transform duration-200", open && "rotate-90")} />
        <Archive className="size-3" />
        <span className="flex-1 text-left">Finished</span>
        <span className="rounded-md bg-zinc-800/80 px-1.5 py-px font-mono text-[10px] font-normal tracking-normal text-zinc-400 normal-case">
          {sessions.length}
        </span>
      </button>
      <Collapse open={open}>
        <div className="max-h-56 space-y-px overflow-y-auto pt-1">
          {sorted.map((s) => {
            const bot = bots.get(s.botId);
            return (
              <button
                key={s.id}
                onClick={() => onSelect(s.id)}
                title={`${s.title} · ${bot?.name ?? ""} · ${providerName(s.provider)}${s.status === "error" ? " · ended with an error" : ""}`}
                className={cx(
                  "flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 pl-2.5 text-left text-[12px] transition-colors",
                  selectedId === s.id ? "bg-zinc-800/90 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300",
                )}
              >
                {bot ? <BlobAvatar avatar={bot.avatar} size="xs" /> : null}
                <ProviderLogo provider={s.provider} size={11} className="shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                {s.status === "error" ? <StatusDot status="error" /> : null}
                <span className="shrink-0 text-[10px] text-zinc-600 tabular-nums">{ago(s.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      </Collapse>
    </div>
  );
}

function SessionRow({ session, selected, onSelect }: { session: Session; selected: boolean; onSelect: () => void }) {
  const reflection = session.role === "reflection";
  return (
    <button
      onClick={onSelect}
      title={`${session.title} · ${providerName(session.provider)} · ${statusLabel[session.status]}`}
      className={cx(
        "group relative flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 pl-3 text-left text-[13px] transition-colors",
        selected ? "bg-zinc-800/90 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
      )}
    >
      <ProviderLogo provider={session.provider} size={13} className={cx("shrink-0", !selected && "opacity-80")} />
      <span className={cx("min-w-0 flex-1 truncate", reflection && "text-zinc-500 italic")}>{session.title}</span>
      {reflection ? <Sparkles className="size-3 shrink-0 text-violet-400/70" /> : null}
      <StatusDot status={session.status} className={session.status === "idle" ? "opacity-0" : ""} />
    </button>
  );
}

function BotGroup({
  bot,
  sessions,
  selectedId,
  onSelect,
  onNewSession,
  onSettings,
}: {
  bot: Bot;
  sessions: ReadonlyArray<Session>;
  selectedId: SessionId | null;
  onSelect: (id: SessionId) => void;
  onNewSession: (bot: Bot) => void;
  onSettings: (bot: Bot) => void;
}) {
  const today = useApp((s) => s.usageToday.get(bot.id));
  const main = sessions.find((s) => s.id === bot.mainSessionId);
  const children = sessions
    .filter((s) => s.id !== bot.mainSessionId && !isFinished(s, selectedId))
    .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || b.createdAt - a.createdAt);
  const busy = children.filter(isBusy).length;
  const selected = selectedId === bot.mainSessionId;

  return (
    <div>
      <div
        className={cx(
          "group flex items-center gap-1 rounded-lg pr-1 transition-colors",
          selected ? "bg-zinc-800/90" : "hover:bg-zinc-900",
        )}
      >
        <button className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2 text-left" onClick={() => onSelect(bot.mainSessionId)}>
          <span className="relative">
            <BotAvatar avatar={bot.avatar} />
            {main && main.status !== "idle" ? (
              <StatusDot status={main.status} className="absolute -right-0.5 -bottom-0.5 size-2 ring-2 ring-zinc-950" />
            ) : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-zinc-100">{bot.name}</span>
            {main ? (
              <span className="flex items-center gap-1 text-[11px] text-zinc-500">
                <ProviderLogo provider={main.provider} size={10} />
                {busy > 0 ? (
                  <span className="text-emerald-400">{busy} working</span>
                ) : today ? (
                  <span title={`Today: ${usageTitle(today)}`}>{formatUsage(today)} today</span>
                ) : (
                  <span>{workerCount(children)}</span>
                )}
              </span>
            ) : null}
          </span>
          {bot.pausedReason !== null ? (
            <span title={`Paused: ${bot.pausedReason}`} className="rounded-md bg-amber-500/15 p-0.5 text-amber-300">
              <Pause className="size-3" />
            </span>
          ) : null}
        </button>
        <span className="flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <IconButton icon={Settings2} label="Bot settings" size="sm" onClick={() => onSettings(bot)} />
          <IconButton icon={SquarePen} label="New session" size="sm" onClick={() => onNewSession(bot)} />
        </span>
      </div>
      {children.length > 0 ? (
        <div className="mt-0.5 ml-[18px] space-y-px border-l border-zinc-800/80 pl-1.5">
          {children.map((s) => (
            <SessionRow key={s.id} session={s} selected={selectedId === s.id} onSelect={() => onSelect(s.id)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Sidebar({
  selectedId,
  onSelect,
  onNewBot,
  onNewSession,
  onBotSettings,
  onDevices,
  onProviders,
  onSettings,
}: {
  selectedId: SessionId | null;
  onSelect: (id: SessionId) => void;
  onNewBot: () => void;
  onNewSession: (bot: Bot) => void;
  onBotSettings: (bot: Bot) => void;
  onDevices: () => void;
  onProviders: () => void;
  onSettings: () => void;
}) {
  const bots = useApp((s) => s.bots);
  const sessions = useApp((s) => s.sessions);
  const connected = useApp((s) => s.connected);
  const allSessions = [...sessions.values()];
  const updates = useProviderVersions().versions.filter((v) => v.updateAvailable);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800/80 bg-[#0c0c0e]">
      <div className="app-drag traffic-light-inset flex h-12 shrink-0 items-center gap-2 px-3">
        <ApolloMark size={18} className="text-zinc-100" />
        <span className="flex-1 text-sm font-semibold tracking-tight text-zinc-100">Apollo</span>
        <IconButton icon={Plus} label="New bot" size="sm" onClick={onNewBot} />
      </div>
      <div className="px-4 pt-2 pb-1.5 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase">Bots</div>
      <nav className="flex-1 space-y-2 overflow-y-auto px-2 pb-3">
        {[...bots.values()].map((bot) => (
          <BotGroup
            key={bot.id}
            bot={bot}
            sessions={allSessions.filter((s) => s.botId === bot.id)}
            selectedId={selectedId}
            onSelect={onSelect}
            onNewSession={onNewSession}
            onSettings={onBotSettings}
          />
        ))}
        {bots.size === 0 && connected ? (
          <button
            onClick={onNewBot}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-zinc-800 px-3 py-3 text-xs text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
          >
            <Plus className="size-3.5" /> Create your first bot
          </button>
        ) : null}
      </nav>
      <FinishedSection
        sessions={allSessions.filter((s) => isFinished(s, selectedId) && bots.has(s.botId))}
        bots={bots}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      <div className="flex h-11 shrink-0 items-center gap-1 border-t border-zinc-800/80 pr-2 pl-4 text-[11px] text-zinc-500">
        <span className={cx("size-1.5 rounded-full", connected ? "bg-emerald-500" : "animate-pulse bg-amber-500")} />
        <span className="flex-1">{connected ? "Connected" : "Connecting…"}</span>
        <IconButton icon={Settings} label="Settings" size="sm" onClick={onSettings} />
        <span className="relative">
          <IconButton
            icon={Blocks}
            label={updates.length > 0 ? `Providers: ${updates.map((u) => providerName(u.provider)).join(", ")} can be updated` : "Providers"}
            size="sm"
            onClick={onProviders}
          />
          {updates.length > 0 ? (
            <span className="pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-sky-400 ring-2 ring-[#0c0c0e]" />
          ) : null}
        </span>
        <IconButton icon={MonitorSmartphone} label="Devices" size="sm" onClick={onDevices} />
      </div>
    </aside>
  );
}
