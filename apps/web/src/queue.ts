import type { AttachmentRef } from "@apollo/contracts";
import { useSyncExternalStore } from "react";

/**
 * Messages written while the agent is busy: they wait here and are sent, one per turn,
 * when the session is idle again. Kept per session in this browser, so a reload keeps them.
 */

export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<AttachmentRef>;
}

const KEY = "apollo.queue";
const EMPTY: ReadonlyArray<QueuedMessage> = [];

const load = (): Map<string, ReadonlyArray<QueuedMessage>> => {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(KEY) ?? "{}")));
  } catch {
    return new Map();
  }
};

let queues = load();
const listeners = new Set<() => void>();

const commit = (sessionId: string, next: ReadonlyArray<QueuedMessage>) => {
  queues = new Map(queues);
  if (next.length === 0) queues.delete(sessionId);
  else queues.set(sessionId, next);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(queues)));
  } catch {
    // Storage off: the queue still works until the page reloads.
  }
  listeners.forEach((l) => l());
};

export const queueOf = (sessionId: string) => queues.get(sessionId) ?? EMPTY;

export const enqueue = (sessionId: string, text: string, attachments: ReadonlyArray<AttachmentRef>) =>
  commit(sessionId, [...queueOf(sessionId), { id: crypto.randomUUID(), text, attachments }]);

export const dequeue = (sessionId: string, id: string) => {
  const message = queueOf(sessionId).find((m) => m.id === id) ?? null;
  commit(
    sessionId,
    queueOf(sessionId).filter((m) => m.id !== id),
  );
  return message;
};

export const useQueue = (sessionId: string) =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => queueOf(sessionId),
  );
