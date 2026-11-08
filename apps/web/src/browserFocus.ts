import { useSyncExternalStore } from "react";

/**
 * Asks the UI to show a browser tab (open the browser panel on it), e.g. when an agent
 * hands the browser to the user. Each request has its own number, so asking twice for
 * the same tab still opens it again.
 */
let request: { tabId: string; n: number } | null = null;
const listeners = new Set<() => void>();

export const focusBrowserTab = (tabId: string) => {
  request = { tabId, n: (request?.n ?? 0) + 1 };
  for (const l of listeners) l();
};

export const useBrowserFocus = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => request,
  );
