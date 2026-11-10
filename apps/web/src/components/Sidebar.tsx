import { type Bot, type BotAvatar as BotAvatarValue, type BotId, type Session, type SessionId, sortBots } from "@apollo/contracts";
import { BlobAvatar } from "./BlobAvatar.tsx";
import { Archive, Blocks, ChevronRight, MonitorSmartphone, Pause, Plus, Settings, Settings2, Sparkles, SquarePen } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { gapAt, moveToGap } from "@apollo/client";
import { formatUsage, usageTitle } from "../format.ts";
import { errorMessage } from "../rpc.ts";
import { reorderBots, useApp } from "../store.ts";
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

/** Where a dragged bot would land: a line above the group (or below the last one). */
function DropLine({ edge }: { edge: "top" | "bottom" }) {
  return (
    <div
      aria-hidden
      className={cx(
        "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.6)]",
        edge === "top" ? "-top-[5px]" : "-bottom-[5px]",
      )}
    >
      <span className="absolute -top-[3px] -left-1 size-2 rounded-full border-2 border-sky-400 bg-[#0c0c0e]" />
    </div>
  );
}

function BotGroup({
  bot,
  sessions,
  selectedId,
  onSelect,
  onNewSession,
  onSettings,
  groupRef,
  dragging,
  dropLine,
  onDragStart,
  onMove,
}: {
  bot: Bot;
  sessions: ReadonlyArray<Session>;
  selectedId: SessionId | null;
  onSelect: (id: SessionId) => void;
  onNewSession: (bot: Bot) => void;
  onSettings: (bot: Bot) => void;
  groupRef: (el: HTMLDivElement | null) => void;
  /** This bot is being dragged. */
  dragging: boolean;
  dropLine: "top" | "bottom" | null;
  onDragStart: (event: ReactPointerEvent) => void;
  /** Keyboard reordering: one place up (-1) or down (+1). */
  onMove: (delta: -1 | 1) => void;
}) {
  const today = useApp((s) => s.usageToday.get(bot.id));
  const main = sessions.find((s) => s.id === bot.mainSessionId);
  const children = sessions
    .filter((s) => s.id !== bot.mainSessionId && !isFinished(s, selectedId))
    .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || b.createdAt - a.createdAt);
  const busy = children.filter(isBusy).length;
  const selected = selectedId === bot.mainSessionId;

  return (
    <div ref={groupRef} className={cx("relative transition-opacity", dragging && "opacity-40")}>
      {dropLine ? <DropLine edge={dropLine} /> : null}
      <div
        onPointerDown={onDragStart}
        onDragStart={(e) => e.preventDefault()}
        className={cx(
          "group flex items-center gap-1 rounded-lg pr-1 transition-colors",
          selected ? "bg-zinc-800/90" : "hover:bg-zinc-900",
          dragging && "bg-zinc-900 ring-1 ring-zinc-700",
        )}
      >
        <button
          className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2 text-left"
          onClick={() => onSelect(bot.mainSessionId)}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          aria-description="Drag, or press Alt+Up or Alt+Down, to reorder"
          onKeyDown={(e) => {
            if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            onMove(e.key === "ArrowUp" ? -1 : 1);
          }}
        >
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

/** Pixels the pointer must travel before a press on a bot becomes a drag (less is a click). */
const DRAG_THRESHOLD = 4;
/** Within this distance of the list's top or bottom edge, a drag scrolls the list. */
const SCROLL_EDGE = 28;

/**
 * Drag-to-reorder for the bot list, with native pointer events (mouse and pen; touch scrolls).
 * A press turns into a drag only past DRAG_THRESHOLD, so clicks and the row's buttons behave as
 * before, and the click that ends a drag is swallowed. Escape cancels. Alt+Up/Down moves the
 * focused bot from the keyboard.
 */
function useBotDrag(ordered: ReadonlyArray<Bot>) {
  const navRef = useRef<HTMLElement | null>(null);
  const groups = useRef(new Map<BotId, HTMLDivElement>());
  const refCallbacks = useRef(new Map<BotId, (el: HTMLDivElement | null) => void>());
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  const [drag, setDrag] = useState<{ id: BotId; from: number; gap: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const commit = (ids: ReadonlyArray<BotId>, moved: Bot, to: number) => {
    setError(null);
    setAnnouncement(`${moved.name} moved to position ${to + 1} of ${ids.length}`);
    reorderBots(ids).catch((e: unknown) => setError(errorMessage(e)));
  };

  const groupRef = (id: BotId) => {
    let callback = refCallbacks.current.get(id);
    if (!callback) {
      callback = (el) => {
        if (el) groups.current.set(id, el);
        else groups.current.delete(id);
      };
      refCallbacks.current.set(id, callback);
    }
    return callback;
  };

  const start = (event: ReactPointerEvent, id: BotId) => {
    if (event.button !== 0 || event.pointerType === "touch" || cleanup.current) return;
    // Indexes are re-read on every move: the list can change under a drag (a push from the server).
    const indexOf = () => orderedRef.current.findIndex((b) => b.id === id);
    let gap = indexOf();
    if (gap < 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    // pressed: not a drag yet (a click); dragging: showing the drop line; canceled: Escape
    // during a drag, waiting for the release so its click can be swallowed.
    let phase: "pressed" | "dragging" | "canceled" = "pressed";

    const rows = () =>
      orderedRef.current.map((b) => {
        const rect = groups.current.get(b.id)?.getBoundingClientRect();
        return rect ? { top: rect.top, bottom: rect.bottom } : { top: 0, bottom: 0 };
      });
    const onMove = (e: PointerEvent) => {
      if (phase === "canceled") return;
      if (phase === "pressed") {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
        phase = "dragging";
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      e.preventDefault();
      const nav = navRef.current;
      if (nav) {
        const rect = nav.getBoundingClientRect();
        if (e.clientY < rect.top + SCROLL_EDGE) nav.scrollBy(0, -8);
        else if (e.clientY > rect.bottom - SCROLL_EDGE) nav.scrollBy(0, 8);
      }
      gap = gapAt(rows(), e.clientY);
      setDrag({ id, from: indexOf(), gap });
    };
    const resetDrag = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setDrag(null);
    };
    // The click that ends a drag must not open the bot (or press a button) under the pointer.
    const swallowClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("keydown", onKey, { capture: true });
      cleanup.current = null;
      resetDrag();
    };
    const onUp = () => {
      const ended = phase;
      stop();
      if (ended === "pressed") return; // a plain click
      window.addEventListener("click", swallowClick, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
      if (ended === "canceled") return;
      const ids = orderedRef.current.map((b) => b.id);
      const from = indexOf();
      const next = moveToGap(ids, from, gap);
      if (next !== ids) commit(next, orderedRef.current[from]!, next.indexOf(id));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || phase !== "dragging") return;
      e.preventDefault();
      e.stopPropagation();
      phase = "canceled";
      resetDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("keydown", onKey, { capture: true });
    cleanup.current = stop;
  };

  const move = (id: BotId, delta: -1 | 1) => {
    const ids = ordered.map((b) => b.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = moveToGap(ids, from, delta < 0 ? to : to + 1);
    commit(next, ordered[from]!, to);
  };

  const dropLineAt = (index: number): "top" | "bottom" | null => {
    if (!drag || drag.gap === drag.from || drag.gap === drag.from + 1) return null;
    if (drag.gap === index) return "top";
    if (index === ordered.length - 1 && drag.gap === ordered.length) return "bottom";
    return null;
  };

  return { navRef, groupRef, start, move, dropLineAt, dragging: drag?.id ?? null, error, announcement };
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
  const ordered = useMemo(() => sortBots(bots.values()), [bots]);
  const order = useBotDrag(ordered);
  const updates = useProviderVersions().versions.filter((v) => v.updateAvailable);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800/80 bg-[#0c0c0e]">
      <div className="app-drag traffic-light-inset flex h-12 shrink-0 items-center gap-2 px-3">
        <ApolloMark size={18} className="text-zinc-100" />
        <span className="flex-1 text-sm font-semibold tracking-tight text-zinc-100">Apollo</span>
        <IconButton icon={Plus} label="New bot" size="sm" onClick={onNewBot} />
      </div>
      <div className="px-4 pt-2 pb-1.5 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase">Bots</div>
      {order.error ? (
        <div role="alert" className="mx-3 mb-1.5 rounded-md bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
          Could not save the new order: {order.error}
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {order.announcement}
      </span>
      <nav ref={order.navRef} className="flex-1 space-y-2 overflow-y-auto px-2 pb-3">
        {ordered.map((bot, index) => (
          <BotGroup
            key={bot.id}
            bot={bot}
            sessions={allSessions.filter((s) => s.botId === bot.id)}
            selectedId={selectedId}
            onSelect={onSelect}
            onNewSession={onNewSession}
            onSettings={onBotSettings}
            groupRef={order.groupRef(bot.id)}
            dragging={order.dragging === bot.id}
            dropLine={order.dropLineAt(index)}
            onDragStart={(e) => order.start(e, bot.id)}
            onMove={(delta) => order.move(bot.id, delta)}
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
