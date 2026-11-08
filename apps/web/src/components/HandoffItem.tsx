import type { SessionId } from "@apollo/contracts";
import type { TranscriptItem } from "@apollo/client";
import { AppWindow, Check, Hand, X } from "lucide-react";
import { useState } from "react";
import { focusBrowserTab } from "../browserFocus.ts";
import { errorMessage, rpc } from "../rpc.ts";
import { Badge, Button, cx, inputClass } from "./ui.tsx";

type Item = Extract<TranscriptItem, { kind: "handoff" }>;

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** The agent handed the browser over: take over the tab, then tell it you are done. */
export function HandoffItem({ item, sessionId }: { item: Item; sessionId: SessionId }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = (outcome: "done" | "cancelled") => {
    setBusy(true);
    setError(null);
    rpc((c) => c["browser.handoffRespond"]({ sessionId, requestId: item.requestId, outcome, ...(note.trim() ? { note: note.trim() } : {}) }))
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  if (item.outcome !== null) {
    return (
      <div className="animate-fade-up flex items-center gap-2.5 rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-3 py-2 text-xs">
        <Hand className="size-3.5 shrink-0 text-zinc-500" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-zinc-400">
          Browser handed over: <span className="text-zinc-200">{item.reason}</span>
        </span>
        <Badge tone={item.outcome === "done" ? "emerald" : item.outcome === "cancelled" ? "red" : "zinc"}>
          {item.outcome === "done" ? "Done" : item.outcome === "cancelled" ? "Declined" : "Expired"}
        </Badge>
      </div>
    );
  }

  return (
    <div className="animate-fade-up rounded-xl border border-sky-600/40 bg-gradient-to-b from-sky-950/30 to-zinc-950 p-3.5 shadow-[0_0_0_4px_rgba(14,165,233,0.05)]">
      <div className="flex items-start gap-3">
        <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-300">
          <Hand className="size-4" strokeWidth={1.75} />
          <span className="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-sky-400" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-sky-50">Your turn in the browser</div>
          <div className="mt-0.5 text-xs leading-relaxed text-zinc-300">{item.reason}</div>
          <div className="mt-1 truncate text-[11px] text-zinc-500">{hostOf(item.url)} · the agent waits until you are done</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => focusBrowserTab(item.tabId)}>
          <AppWindow /> Open the tab
        </Button>
        <input
          className={cx(inputClass, "min-w-40 flex-1 text-xs")}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note for the agent (optional)"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) respond("done");
          }}
        />
        <Button disabled={busy} onClick={() => respond("done")}>
          <Check /> Done
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => respond("cancelled")} title="Tell the agent you won't do it">
          <X />
        </Button>
      </div>
      {error ? <div className="mt-2 text-xs text-red-400">{error}</div> : null}
    </div>
  );
}
