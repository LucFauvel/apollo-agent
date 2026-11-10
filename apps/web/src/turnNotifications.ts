import type { SessionId } from "@apollo/contracts";
import { onNotify } from "./store.ts";

/** Brings Apollo forward; in the desktop app the window may be hidden, which only the shell can undo. */
export const showApp = () => {
  if (/Electron\//.test(navigator.userAgent)) window.open("apollo-desktop://show");
  window.focus();
};

/**
 * Desktop notifications in a browser tab when a conversation finishes a turn with something
 * for the user, needs an approval or an answer, or fails, while they are not looking at it
 * (another app in front, or another session open). The server decides which turns are worth
 * it (the same ones it pushes to phones: not a turn that only waits on a worker, a job or
 * another bot) and sends them as `pushed` notifications. Clicking one opens the session.
 */
export const watchTurns = (selected: () => SessionId | null, open: (id: SessionId) => void) => {
  if (typeof Notification === "undefined") return () => undefined;
  if (Notification.permission === "default") void Notification.requestPermission();
  return onNotify((notice) => {
    if (!notice.pushed || !notice.sessionId || Notification.permission !== "granted") return;
    const sessionId = notice.sessionId;
    if (document.hasFocus() && selected() === sessionId) return;
    const notification = new Notification(notice.title, { body: notice.body, tag: `turn-${sessionId}` });
    notification.onclick = () => {
      showApp();
      open(sessionId);
    };
  });
};
