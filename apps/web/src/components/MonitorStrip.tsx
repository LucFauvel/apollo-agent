import { monitorStatusLine, runningMonitors } from "@apollo/client";
import type { Monitor, Session } from "@apollo/contracts";
import { Radar, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { errorMessage, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";
import { Tooltip } from "./ui.tsx";

/** Re-renders every `ms` while `active`, for elapsed times. */
const useNow = (active: boolean, ms = 10_000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
};

/**
 * Above the message box: the monitors this session's agent set up (apollo_monitor_start),
 * what each watches, its latest event, and a Stop button. The agent is told when the user
 * stops one.
 */
export function MonitorStrip({ session }: { session: Session }) {
  const all = useApp((s) => s.monitors);
  const monitors = useMemo(() => runningMonitors(all.values(), session.id), [all, session.id]);
  const now = useNow(monitors.length > 0);
  if (monitors.length === 0) return null;
  return (
    <div className="mb-2 space-y-1.5">
      {monitors.map((m) => (
        <MonitorRow key={m.id} monitor={m} now={now} />
      ))}
    </div>
  );
}

function MonitorRow({ monitor, now }: { monitor: Monitor; now: number }) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = () => {
    setStopping(true);
    setError(null);
    rpc((c) => c["monitors.stop"]({ monitorId: monitor.id })).catch((e: unknown) => {
      setStopping(false);
      setError(errorMessage(e));
    });
  };
  return (
    <div className="animate-pop-in flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
      <Radar className="size-4 shrink-0 animate-pulse text-emerald-300" aria-hidden />
      <Tooltip
        align="start"
        content={
          <span className="block max-w-md font-mono text-[11px] break-all whitespace-pre-wrap">
            {monitor.command}
            {"\n"}in {monitor.cwd}
          </span>
        }
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-xs font-medium text-emerald-100">Monitoring: {monitor.description}</span>
            <span className="shrink-0 text-[11px] text-zinc-500">{monitorStatusLine(monitor, now)}</span>
          </div>
          {error ? (
            <div className="truncate text-[11px] text-red-400">{error}</div>
          ) : monitor.lastEvent ? (
            <div className="truncate font-mono text-[11px] text-zinc-400">{monitor.lastEvent}</div>
          ) : null}
        </div>
      </Tooltip>
      <button
        type="button"
        onClick={stop}
        disabled={stopping}
        className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
      >
        <Square className="size-3 fill-current" /> {stopping ? "Stopping…" : "Stop"}
      </button>
    </div>
  );
}
