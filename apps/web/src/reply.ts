import type { ReplyRef } from "@apollo/contracts";
import { useSyncExternalStore } from "react";

/** The message each session's composer replies to, set from a message's Reply button. */

let targets = new Map<string, ReplyRef>();
const listeners = new Set<() => void>();

export const setReplyTarget = (sessionId: string, target: ReplyRef | null) => {
  targets = new Map(targets);
  if (target) targets.set(sessionId, target);
  else targets.delete(sessionId);
  listeners.forEach((l) => l());
};

export const useReplyTarget = (sessionId: string) =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => targets.get(sessionId) ?? null,
  );
