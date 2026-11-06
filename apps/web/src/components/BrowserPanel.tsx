import type { Bot, BrowserInput, BrowserStatus, BrowserTab } from "@apollo/contracts";
import { AppWindow, ArrowLeft, ArrowRight, Globe, Loader2, MousePointerClick, Plus, RotateCw, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, follow, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";
import { ProviderLogo } from "./icons.tsx";
import { cx, EmptyState, IconButton, inputClass, Panel } from "./ui.tsx";

const SPECIAL_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === "about:" ? "New tab" : u.host;
  } catch {
    return url;
  }
};

/** The tab's live frames, with the user's clicks, scrolls and keys sent back to the page. */
function LiveView({ tab }: { tab: BrowserTab }) {
  const img = useRef<HTMLImageElement>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wheel = useRef({ dx: 0, dy: 0, x: 0.5, y: 0.5, timer: 0 });

  useEffect(() => {
    setHasFrame(false);
    return follow(
      (client) => client["browser.watch"]({ tabId: tab.id }),
      (frame) => {
        if (img.current) img.current.src = `data:image/jpeg;base64,${frame.data}`;
        setHasFrame(true);
      },
    );
  }, [tab.id]);

  const send = (input: BrowserInput) => {
    setError(null);
    rpc((c) => c["browser.input"]({ tabId: tab.id, input })).catch((e) => setError(errorMessage(e)));
  };

  const position = (e: { clientX: number; clientY: number }) => {
    const rect = img.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) return; // Leave shortcuts (copy, paste, reload) to the app.
    if (SPECIAL_KEYS.has(e.key)) send({ _tag: "key", key: e.key });
    else if (e.key.length === 1) send({ _tag: "text", text: e.key });
    else return;
    e.preventDefault();
  };

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-zinc-900/40 p-3">
      <div
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKey}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (text) send({ _tag: "text", text });
        }}
        className={cx(
          "relative mx-auto aspect-[1280/800] w-full overflow-hidden rounded-lg border bg-white shadow-xl shadow-black/30 transition-shadow outline-none",
          focused ? "border-sky-500/60 ring-2 ring-sky-500/20" : "border-zinc-800",
        )}
      >
        <img
          ref={img}
          alt={tab.title || tab.url}
          draggable={false}
          className={cx("block size-full cursor-default object-contain transition-opacity duration-300", hasFrame ? "opacity-100" : "opacity-0")}
          onClick={(e) => send({ _tag: "click", ...position(e) })}
          onWheel={(e) => {
            // Batch wheel events into one scroll every 50 ms.
            const w = wheel.current;
            w.dx += e.deltaX;
            w.dy += e.deltaY;
            Object.assign(w, position(e));
            if (!w.timer) {
              w.timer = window.setTimeout(() => {
                send({ _tag: "scroll", x: w.x, y: w.y, deltaX: w.dx, deltaY: w.dy });
                Object.assign(w, { dx: 0, dy: 0, timer: 0 });
              }, 50);
            }
          }}
        />
        {!hasFrame ? (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900">
            <Loader2 className="size-5 animate-spin text-zinc-500" />
          </div>
        ) : null}
        {tab.loading ? <div className="animate-shimmer absolute inset-x-0 top-0 h-0.5 bg-[linear-gradient(90deg,transparent,#38bdf8,transparent)] bg-[length:200%_100%]" /> : null}
      </div>
      <div className="mt-2 flex items-center gap-1.5 px-1 text-[11px] text-zinc-500">
        <MousePointerClick className="size-3" />
        {error ? <span className="text-red-400">{error}</span> : focused ? "Typing goes to the page." : "Click the page to interact; agents see your changes."}
      </div>
    </div>
  );
}

function TabPill({ tab, selected, onSelect }: { tab: BrowserTab; selected: boolean; onSelect: () => void }) {
  return (
    <div
      className={cx(
        "group flex h-7 max-w-44 min-w-0 shrink-0 items-center gap-1.5 rounded-lg pr-1 pl-2 text-xs transition-colors",
        selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
      )}
    >
      <button className="flex min-w-0 flex-1 items-center gap-1.5" onClick={onSelect} title={`${tab.title}\n${tab.url}`}>
        {tab.loading ? <Loader2 className="size-3 shrink-0 animate-spin" /> : <Globe className="size-3 shrink-0 opacity-70" />}
        <span className="truncate">{tab.title || hostOf(tab.url)}</span>
      </button>
      <IconButton
        icon={X}
        label="Close tab"
        size="sm"
        className="size-5 opacity-0 group-hover:opacity-100"
        onClick={() => void rpc((c) => c["browser.close"]({ tabId: tab.id }))}
      />
    </div>
  );
}

function AddressBar({ tab, onError }: { tab: BrowserTab; onError: (message: string | null) => void }) {
  const [draft, setDraft] = useState(tab.url);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(tab.url === "about:blank" ? "" : tab.url);
  }, [tab.url, editing]);
  const history = (direction: "back" | "forward" | "reload") =>
    rpc((c) => c["browser.input"]({ tabId: tab.id, input: { _tag: "history", direction } })).catch((e) => onError(errorMessage(e)));
  return (
    <div className="flex items-center gap-1 border-b border-zinc-800/80 px-2 py-1.5">
      <IconButton icon={ArrowLeft} label="Back" size="sm" onClick={() => void history("back")} />
      <IconButton icon={ArrowRight} label="Forward" size="sm" onClick={() => void history("forward")} />
      <IconButton icon={RotateCw} label="Reload" size="sm" onClick={() => void history("reload")} />
      <form
        className="min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          onError(null);
          (e.currentTarget.elements.namedItem("url") as HTMLInputElement).blur();
          rpc((c) => c["browser.navigate"]({ tabId: tab.id, url: draft })).catch((err) => onError(errorMessage(err)));
        }}
      >
        <input
          name="url"
          className={cx(inputClass, "h-7 rounded-full px-3 py-0 font-mono text-[11px]")}
          value={draft}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search or enter address"
          spellCheck={false}
        />
      </form>
    </div>
  );
}

/** Opens a page from the panel; it belongs to the bot's orchestrator. */
function OpenPage({ bot, onError, compact = false }: { bot: Bot; onError: (message: string | null) => void; compact?: boolean }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={cx("flex gap-2", compact ? "" : "w-full max-w-xs")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!url.trim()) return;
        setBusy(true);
        onError(null);
        rpc((c) => c["browser.open"]({ botId: bot.id, url }))
          .then(() => setUrl(""))
          .catch((err) => onError(errorMessage(err)))
          .finally(() => setBusy(false));
      }}
    >
      <input className={cx(inputClass, "font-mono text-xs")} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="localhost:5173 or example.com" />
      <button
        type="submit"
        disabled={busy || !url.trim()}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-600"
        title="Open"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
      </button>
    </form>
  );
}

export function BrowserPanel({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const all = useApp((s) => s.browserTabs);
  const sessions = useApp((s) => s.sessions);
  const tabs = useMemo(() => [...all.values()].filter((t) => t.botId === bot.id).sort((a, b) => a.openedAt - b.openedAt), [all, bot.id]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void rpc((c) => c["browser.status"]()).then(setStatus, () => undefined);
  }, []);

  // Follow the newest tab when one opens (usually an agent starting to browse).
  const newest = tabs.at(-1)?.id ?? null;
  useEffect(() => {
    setSelectedId(newest);
    setAdding(false);
  }, [newest]);

  const tab = tabs.find((t) => t.id === selectedId) ?? tabs.at(-1) ?? null;
  const owner = tab ? sessions.get(tab.sessionId) : undefined;

  return (
    <Panel
      width="wide"
      onClose={onClose}
      title={
        <span className="flex items-center gap-2 text-[13px] font-semibold text-zinc-100">
          Browser
          {owner ? (
            <span className="flex min-w-0 items-center gap-1 truncate text-[11px] font-normal text-zinc-500">
              · driven by <ProviderLogo provider={owner.provider} size={11} /> {owner.role === "main" ? bot.name : owner.title}
            </span>
          ) : null}
        </span>
      }
      actions={tabs.length > 0 ? <IconButton icon={Plus} label="New tab" size="sm" active={adding} onClick={() => setAdding(!adding)} /> : null}
    >
      {tabs.length > 0 ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-800/80 px-2 py-1.5">
          {tabs.map((t) => (
            <TabPill key={t.id} tab={t} selected={t.id === tab?.id} onSelect={() => setSelectedId(t.id)} />
          ))}
        </div>
      ) : null}
      {adding ? (
        <div className="animate-fade-up border-b border-zinc-800/80 p-2">
          <OpenPage bot={bot} onError={setError} compact />
        </div>
      ) : null}
      {tab ? <AddressBar key={`address:${tab.id}`} tab={tab} onError={setError} /> : null}
      {error ? <div className="border-b border-red-900/40 bg-red-950/30 px-3 py-1.5 text-xs text-red-300">{error}</div> : null}
      {tab ? (
        <LiveView key={`view:${tab.id}`} tab={tab} />
      ) : (
        <div className="flex flex-1 flex-col items-center overflow-y-auto">
          <EmptyState icon={AppWindow} title="No pages open">
            {status && !status.available ? (
              <span className="text-amber-300">{status.message}</span>
            ) : (
              <>
                {bot.name}'s sessions open pages here with the browser tools, and you can watch them live. You can also open
                one yourself.
              </>
            )}
          </EmptyState>
          {status?.available !== false ? <OpenPage bot={bot} onError={setError} /> : null}
        </div>
      )}
    </Panel>
  );
}
