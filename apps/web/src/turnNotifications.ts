import { seenNotifications } from "@apollo/client";
import type { BotId, SessionId } from "@apollo/contracts";
import { rpc } from "./rpc.ts";
import { getAppState, onNotify, subscribeApp } from "./store.ts";

/** Brings Apollo forward; in the desktop app the window may be hidden, which only the shell can undo. */
export const showApp = () => {
  if (/Electron\//.test(navigator.userAgent)) window.open("apollo-desktop://show");
  window.focus();
};

/**
 * Notifications this tab showed and has not closed, with their bot and when the server sent
 * them: closed once its chats are seen after that.
 */
const shown = new Set<{
  readonly notification: Notification;
  readonly botId: string;
  readonly at: number | undefined;
  readonly receivedAt: number;
}>();

/**
 * Shows a notification for a bot (kept, to be closed when the user sees that bot's chats).
 * `at` is when the server sent it: seen marks are server time, and this device's clock may
 * be off. (When it arrived here stands in, from a server that does not say.)
 */
export const showNotification = (
  notice: { readonly botId: string; readonly at?: number | undefined },
  title: string,
  options: NotificationOptions,
  onClick: () => void,
) => {
  const notification = new Notification(title, options);
  const entry = { notification, botId: notice.botId, at: notice.at, receivedAt: Date.now() };
  shown.add(entry);
  notification.onclick = () => {
    shown.delete(entry);
    onClick();
  };
  notification.onclose = () => void shown.delete(entry);
};

/** Closes the notifications of bots whose chats were seen since (here or on another device). */
const dismissSeen = (marks: ReadonlyMap<string, number>) => {
  for (const entry of seenNotifications(shown, marks)) {
    shown.delete(entry);
    entry.notification.close();
  }
};

/**
 * Desktop notifications in a browser tab when a conversation finishes a turn with something
 * for the user, needs an approval or an answer, or fails, while they are not looking at it
 * (another app in front, or another session open). The server decides which turns are worth
 * it (the same ones it pushes to phones: not a turn that only waits on a worker, a job or
 * another bot) and sends them as `pushed` notifications, including a provider that failed to
 * start for a message. A scheduled result the server announces itself stands in for its
 * turn's, so it shows once (App.tsx shows those). Clicking one opens the session.
 * Notifications of a bot close once its chats are seen, on this device or another.
 */
export const watchTurns = (selected: () => SessionId | null, open: (id: SessionId) => void) => {
  if (typeof Notification === "undefined") return () => undefined;
  if (Notification.permission === "default") void Notification.requestPermission();
  let marks = getAppState().notificationsSeen;
  const stopSeen = subscribeApp(() => {
    const next = getAppState().notificationsSeen;
    if (next === marks) return;
    marks = next;
    dismissSeen(marks);
  });
  const stopNotify = onNotify((notice) => {
    if (!notice.pushed || !notice.sessionId || Notification.permission !== "granted") return;
    const sessionId = notice.sessionId;
    if (document.hasFocus() && selected() === sessionId) return;
    showNotification(notice, notice.title, { body: notice.body, tag: `turn-${sessionId}` }, () => {
      showApp();
      open(sessionId);
    });
  });
  return () => {
    stopSeen();
    stopNotify();
  };
};

/**
 * Tells the server the user sees this bot's chats: when one of its sessions opens, and when
 * the window comes back to the front with one open. (Not when a notification arrives while
 * it is open: only being shown the chat counts.) Its notifications are then dismissed on
 * every device.
 */
export const watchSeen = (selectedBot: () => BotId | null) => {
  let last: { botId: BotId; at: number } | null = null;
  const check = () => {
    const botId = selectedBot();
    if (!botId || document.visibilityState !== "visible" || !document.hasFocus()) return;
    // (Focus can bounce; one mark a few seconds is plenty.)
    if (last && last.botId === botId && Date.now() - last.at < 3_000) return;
    last = { botId, at: Date.now() };
    void rpc((c) => c["notifications.seen"]({ botId })).catch(() => undefined);
  };
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", check);
  return {
    /** The open session changed. */
    check,
    stop: () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    },
  };
};
