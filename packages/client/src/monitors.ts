import type { Monitor, SessionId } from "@apollo/contracts";

/** A session's running monitors, oldest first. */
export const runningMonitors = (monitors: Iterable<Monitor>, sessionId: SessionId) =>
  [...monitors].filter((m) => m.sessionId === sessionId && m.status === "running").sort((a, b) => a.startedAt - b.startedAt);

const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
};

/** A line about a running monitor: how many events it delivered, and when it stops on its own. */
export const monitorStatusLine = (m: Monitor, now: number) => {
  const events = m.events === 0 ? "no events yet" : `${m.events} event${m.events === 1 ? "" : "s"}`;
  const ends = m.deadline === null ? "until stopped" : `stops in ${span(m.deadline - now)}`;
  return `${events} · running ${span(now - m.startedAt)} · ${ends}`;
};
