/**
 * How the conversation shows each turn's changes card: the latest turn's open, earlier ones
 * folded to one line, and the ones the user cleared hidden. Shared by the web and phone apps.
 */
import type { ConversationChanges } from "@apollo/contracts";

/**
 * The changes card of the latest turn: the last card, unless a message came after it (a new
 * turn started, so that card belongs to history). Open without interaction; others fold.
 */
export const currentChangesKey = (items: ReadonlyArray<{ readonly kind: string; readonly key: string }>): string | null => {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "changes") return item.key;
    if (item.kind === "user") return null;
  }
  return null;
};

/** The latest changes card, whichever turn: when it changes, folded history folds again. */
export const latestChangesKey = (items: ReadonlyArray<{ readonly kind: string; readonly key: string }>): string | null => {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === "changes") return items[i]!.key;
  return null;
};

/** A conversation item as the cards logic sees it: changes items may carry a full-diff `report`. */
type CardItem = { readonly kind: string; readonly key: string; readonly report?: unknown };

/** A full diff the user asked for (`apollo_semantic_diff`): clearable, but not a turn's changes card. */
export const isFullDiff = (item: CardItem): boolean => item.kind === "changes" && !!item.report;

/**
 * The items without full diffs, for `currentChangesKey` and `latestChangesKey`: a full diff
 * neither takes the place of the latest turn's card nor folds history again.
 */
export const withoutFullDiffs = <T extends CardItem>(items: ReadonlyArray<T>): ReadonlyArray<T> => items.filter((item) => !isFullDiff(item));

/** Whether the conversation shows any clearable card (a turn's changes or a full diff). */
export const hasCards = (items: ReadonlyArray<CardItem>): boolean => items.some((item) => item.kind === "changes");

/** Each turn's summary by turn seq (the newest if there are several). */
export const summariesByTurn = (changes: ConversationChanges | null): ReadonlyMap<number, string> => {
  const byTurn = new Map<number, string>();
  for (const s of changes?.summaries ?? []) if (!byTurn.has(s.turnSeq)) byTurn.set(s.turnSeq, s.text);
  return byTurn;
};

/**
 * A reconnect may have missed ChangesUpdated notifications: count it as one for every bot,
 * including bots this client has not heard about yet (they start from no version at all).
 */
export const invalidateChanges = <K>(versions: ReadonlyMap<K, number>, botIds: Iterable<K>): ReadonlyMap<K, number> => {
  const next = new Map(versions);
  for (const id of [...versions.keys(), ...botIds]) next.set(id, (versions.get(id) ?? 0) + 1);
  return next;
};

// --- clearing cards ---------------------------------------------------------------------

let clock = 0;
/**
 * A tick of one counter shared by every view and session, and that only goes up: ids of
 * fetches and requests, and the moment a request was accepted. An id from an earlier visit
 * to a session can never be mistaken for one of this visit.
 */
export const cardsTick = () => ++clock;

/**
 * The cards state of one view of a session's conversation: the server's copy plus the
 * user's requests in flight, laid over it. Nothing here remembers a value to roll back to:
 * a request that fails just stops being laid over, and every settled request starts a
 * refetch, so the view always converges to what the server says.
 */
export interface CardsState {
  readonly sessionId: string;
  readonly server: ConversationChanges | null;
  /**
   * The last fetch this view issued (whatever started it: mount, a ChangesUpdated, a
   * reconnect, a settled request). Only its answer is applied; earlier ones are stale.
   */
  readonly latestFetch: number | null;
  /** Counts settled requests: each one makes the view fetch again. */
  readonly epoch: number;
  /** Per card, the latest request for it; `acceptedAt` (a tick) once the server took it. */
  readonly pending: ReadonlyMap<number, { readonly id: number; readonly dismissed: boolean; readonly acceptedAt: number | null }>;
  /** Cleared while this view is open: they offer an undo instead of vanishing. */
  readonly justCleared: ReadonlySet<number>;
}

/**
 * Every action names the session it was issued for: one for another session is ignored.
 * `fetchId`, `id` and `tick` come from `cardsTick()`.
 */
export type CardsAction =
  /** A new visit: everything issued before it is forgotten. */
  | { readonly type: "reset"; readonly sessionId: string }
  /** Dispatched as a fetch is sent, before its answer can arrive. */
  | { readonly type: "fetching"; readonly sessionId: string; readonly fetchId: number }
  | { readonly type: "fetched"; readonly sessionId: string; readonly fetchId: number; readonly changes: ConversationChanges }
  | { readonly type: "requested"; readonly sessionId: string; readonly id: number; readonly seq: number; readonly dismissed: boolean }
  | { readonly type: "settled"; readonly sessionId: string; readonly id: number; readonly seq: number; readonly ok: boolean; readonly tick: number };

export const initialCards = (sessionId: string): CardsState => ({
  sessionId,
  server: null,
  latestFetch: null,
  epoch: 0,
  pending: new Map(),
  justCleared: new Set(),
});

export const reduceCards = (state: CardsState, action: CardsAction): CardsState => {
  if (action.type === "reset") return initialCards(action.sessionId);
  if (action.sessionId !== state.sessionId) return state;
  switch (action.type) {
    case "fetching":
      return action.fetchId > (state.latestFetch ?? 0) ? { ...state, latestFetch: action.fetchId } : state;
    case "fetched": {
      // A newer fetch was issued (or this one is from an earlier visit): its answer will do.
      if (action.fetchId !== state.latestFetch) return state;
      // A request the server accepted before this fetch was sent is in its answer.
      const pending = new Map([...state.pending].filter(([, p]) => p.acceptedAt === null || p.acceptedAt > action.fetchId));
      return { ...state, server: action.changes, pending };
    }
    case "requested": {
      const pending = new Map(state.pending).set(action.seq, { id: action.id, dismissed: action.dismissed, acceptedAt: null });
      const justCleared = action.dismissed ? new Set(state.justCleared).add(action.seq) : state.justCleared;
      return { ...state, pending, justCleared };
    }
    case "settled": {
      const epoch = state.epoch + 1;
      const current = state.pending.get(action.seq);
      // A newer request for the same card owns it now.
      if (current?.id !== action.id) return { ...state, epoch };
      const pending = new Map(state.pending);
      if (action.ok) pending.set(action.seq, { ...current, acceptedAt: action.tick });
      else pending.delete(action.seq);
      return { ...state, epoch, pending };
    }
  }
};

/** The cards hidden from the conversation: the server's, with requests in flight laid over. */
export const dismissedCards = (state: CardsState): ReadonlySet<number> => {
  const dismissed = new Set(state.server?.dismissed ?? []);
  for (const [seq, p] of state.pending) {
    if (p.dismissed) dismissed.add(seq);
    else dismissed.delete(seq);
  }
  return dismissed;
};
