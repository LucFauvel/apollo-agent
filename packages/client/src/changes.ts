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

/**
 * The cards state of one session's conversation: the server's copy plus the user's requests
 * in flight, laid over it. Nothing here remembers a value to roll back to: a request that
 * fails just stops being laid over, and every settled request starts a refetch, so the view
 * always converges to what the server says.
 */
export interface CardsState {
  readonly sessionId: string;
  readonly server: ConversationChanges | null;
  /** The epoch of the fetch the server copy comes from: older answers are dropped. */
  readonly serverEpoch: number;
  /** Advanced when a request settles; a fetch issued from then on sees its outcome. */
  readonly epoch: number;
  /** Per card, the latest request for it; `confirmedAt` once the server accepted it. */
  readonly pending: ReadonlyMap<number, { readonly id: number; readonly dismissed: boolean; readonly confirmedAt: number | null }>;
  /** Cleared while this view is open: they offer an undo instead of vanishing. */
  readonly justCleared: ReadonlySet<number>;
}

/** Every action names the session it was issued for: a late one for another session is ignored. */
export type CardsAction =
  | { readonly type: "reset"; readonly sessionId: string }
  /** `epoch`: the state's epoch when the fetch was issued. */
  | { readonly type: "fetched"; readonly sessionId: string; readonly epoch: number; readonly changes: ConversationChanges }
  | { readonly type: "requested"; readonly sessionId: string; readonly id: number; readonly seq: number; readonly dismissed: boolean }
  | { readonly type: "settled"; readonly sessionId: string; readonly id: number; readonly seq: number; readonly ok: boolean };

export const initialCards = (sessionId: string): CardsState => ({
  sessionId,
  server: null,
  serverEpoch: -1,
  epoch: 0,
  pending: new Map(),
  justCleared: new Set(),
});

export const reduceCards = (state: CardsState, action: CardsAction): CardsState => {
  if (action.type === "reset") return initialCards(action.sessionId);
  if (action.sessionId !== state.sessionId) return state;
  switch (action.type) {
    case "fetched": {
      if (action.epoch < state.serverEpoch) return state;
      // A request the server accepted before this fetch was issued is in its answer now.
      const pending = new Map([...state.pending].filter(([, p]) => p.confirmedAt === null || p.confirmedAt > action.epoch));
      return { ...state, server: action.changes, serverEpoch: action.epoch, pending };
    }
    case "requested": {
      const pending = new Map(state.pending).set(action.seq, { id: action.id, dismissed: action.dismissed, confirmedAt: null });
      const justCleared = action.dismissed ? new Set(state.justCleared).add(action.seq) : state.justCleared;
      return { ...state, pending, justCleared };
    }
    case "settled": {
      const epoch = state.epoch + 1;
      const current = state.pending.get(action.seq);
      // A newer request for the same card owns it now.
      if (current?.id !== action.id) return { ...state, epoch };
      const pending = new Map(state.pending);
      if (action.ok) pending.set(action.seq, { ...current, confirmedAt: epoch });
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

let nextRequestId = 0;
/** Ids for `requested`/`settled`, unique across sessions and views. */
export const cardRequestId = () => ++nextRequestId;
