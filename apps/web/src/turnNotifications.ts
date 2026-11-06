import type { Session, SessionId } from "@apollo/contracts";
import { getAppState, onNotify, subscribeApp } from "./store.ts";

/** Brings Apollo forward; in the desktop app the window may be hidden, which only the shell can undo. */
export const showApp = () => {
  if (/Electron\//.test(navigator.userAgent)) window.open("apollo-desktop://show");
  window.focus();
};

const busy = (s: Session) => s.status === "running" || s.status === "starting";

/** Plain text for a notification body: no markdown, one short line. */
const summary = (text: string | null) =>
  (text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>[\]]|\(https?:[^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

/**
 * Desktop notifications when a conversation the user started finishes a turn, needs an
 * approval, or fails, while they are not looking at it (another app in front, or another
 * session open). Workers a bot spawned are left out: their orchestrator reports on them.
 * Clicking a notification opens the session.
 */
export const watchTurns = (selected: () => SessionId | null, open: (id: SessionId) => void) => {
  if (typeof Notification === "undefined") return () => undefined;
  if (Notification.permission === "default") void Notification.requestPermission();

  let previous = new Map<SessionId, Session["status"]>();
  for (const s of getAppState().sessions.values()) previous.set(s.id, s.status);
  // The server already notified about this session (e.g. a scheduled result): do not repeat it.
  const recentlyNotified = new Map<string, number>();
  const stopNotices = onNotify((n) => {
    if (n.sessionId) recentlyNotified.set(n.sessionId, Date.now());
  });

  const stop = subscribeApp(() => {
    const { sessions, bots } = getAppState();
    const next = new Map<SessionId, Session["status"]>();
    for (const session of sessions.values()) {
      next.set(session.id, session.status);
      const before = previous.get(session.id);
      if (before === undefined || before === session.status) continue;
      if (session.role === "reflection" || (session.role === "worker" && session.parentSessionId !== null)) continue;
      const watching = document.hasFocus() && selected() === session.id;
      if (watching || Notification.permission !== "granted") continue;

      const bot = bots.get(session.botId);
      const who = session.role === "main" ? (bot?.name ?? "Your bot") : `${session.title} (${bot?.name ?? "worker"})`;
      let title: string | null = null;
      let body = "";
      if (session.status === "waiting-approval") {
        title = `${who} needs your approval`;
        body = "Open Apollo to allow or decline.";
      } else if (before === "running" || before === "waiting-approval") {
        // (starting → idle is a process opening, e.g. to list commands, not a finished turn)
        if (session.status === "error") {
          title = `${who} stopped with an error`;
        } else if (session.status === "idle" && !busy(session)) {
          if ((session.lastMessage ?? "").trim() === "[SILENT]") continue;
          if (Date.now() - (recentlyNotified.get(session.id) ?? 0) < 10_000) continue;
          title = `${who} finished`;
          body = summary(session.lastMessage) || "The turn is done.";
        }
      }
      if (!title) continue;
      const notification = new Notification(title, { body, tag: `turn-${session.id}` });
      notification.onclick = () => {
        showApp();
        open(session.id);
      };
    }
    previous = next;
  });

  return () => {
    stop();
    stopNotices();
  };
};
