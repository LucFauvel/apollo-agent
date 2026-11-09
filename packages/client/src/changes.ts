/**
 * How the conversation shows each turn's changes card (the latest turn's open, earlier ones
 * folded to one line), and how the Changes panel clears turns. Shared by the web and phone apps.
 */
import type { ChangesOverview, ClearedChanges, ConversationChanges, SessionChanges } from "@apollo/contracts";

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

/** A full diff the user asked for (`apollo_semantic_diff`): a changes card, but not a turn's. */
export const isFullDiff = (item: CardItem): boolean => item.kind === "changes" && !!item.report;

/**
 * The items without full diffs, for `currentChangesKey` and `latestChangesKey`: a full diff
 * neither takes the place of the latest turn's card nor folds history again.
 */
export const withoutFullDiffs = <T extends CardItem>(items: ReadonlyArray<T>): ReadonlyArray<T> => items.filter((item) => !isFullDiff(item));

/** Whether the items show any changes card (pass them `withoutFullDiffs` for turns' cards only). */
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

// --- what the server says, with the user's requests laid over -------------------------

let clock = 0;
/**
 * A tick of one counter shared by every view and session, and that only goes up: ids of
 * fetches and requests, and the moment a request was accepted. An id from an earlier visit
 * to a view can never be mistaken for one of this visit.
 */
export const cardsTick = () => ++clock;

/**
 * One view's copy of something the server keeps (a conversation's changes, the Changes
 * panel's overview), plus the user's clear requests in flight, laid over it. Nothing here
 * remembers a value to roll back to: a request that fails just stops being laid over, and
 * every settled request starts a refetch, so the view always converges to what the server says.
 */
export interface SyncedState<S> {
  /** The session the view is of. */
  readonly sessionId: string;
  readonly server: S | null;
  /**
   * The last fetch this view issued (whatever started it: mount, a ChangesUpdated, a
   * reconnect, a settled request). Only its answer is applied; earlier ones are stale.
   */
  readonly latestFetch: number | null;
  /** Counts settled requests: each one makes the view fetch again. */
  readonly epoch: number;
  /** Per cleared thing (`dismissKey`), the latest request for it; `acceptedAt` (a tick) once the server took it. */
  readonly pending: ReadonlyMap<string, { readonly id: number; readonly dismissed: boolean; readonly acceptedAt: number | null }>;
}

/**
 * Every action names the session whose view it was issued for: one for another is ignored.
 * `fetchId`, `id` and `tick` come from `cardsTick()`.
 */
export type SyncedAction<S> =
  /** A new visit: everything issued before it is forgotten. */
  | { readonly type: "reset"; readonly sessionId: string }
  /** Dispatched as a fetch is sent, before its answer can arrive. */
  | { readonly type: "fetching"; readonly sessionId: string; readonly fetchId: number }
  | { readonly type: "fetched"; readonly sessionId: string; readonly fetchId: number; readonly changes: S }
  | { readonly type: "requested"; readonly sessionId: string; readonly id: number; readonly key: string; readonly dismissed: boolean }
  | { readonly type: "settled"; readonly sessionId: string; readonly id: number; readonly key: string; readonly ok: boolean; readonly tick: number };

export const initialSynced = <S>(sessionId: string): SyncedState<S> => ({ sessionId, server: null, latestFetch: null, epoch: 0, pending: new Map() });

export const reduceSynced = <S>(state: SyncedState<S>, action: SyncedAction<S>): SyncedState<S> => {
  if (action.type === "reset") return initialSynced(action.sessionId);
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
      const pending = new Map(state.pending).set(action.key, { id: action.id, dismissed: action.dismissed, acceptedAt: null });
      return { ...state, pending };
    }
    case "settled": {
      const epoch = state.epoch + 1;
      const current = state.pending.get(action.key);
      // A newer request for the same thing owns it now.
      if (current?.id !== action.id) return { ...state, epoch };
      const pending = new Map(state.pending);
      if (action.ok) pending.set(action.key, { ...current, acceptedAt: action.tick });
      else pending.delete(action.key);
      return { ...state, epoch, pending };
    }
  }
};

// --- the conversation's cards: the summaries only (nothing is cleared from it) -----------

export type CardsState = SyncedState<ConversationChanges>;
export type CardsAction = SyncedAction<ConversationChanges>;
export const initialCards = (sessionId: string): CardsState => initialSynced(sessionId);
export const reduceCards = (state: CardsState, action: CardsAction): CardsState => reduceSynced(state, action);

// --- the Changes panel: clearing a session's turns, and bringing them back ---------------

/**
 * Clearing is durable (the server keeps it), but the way back is not: only what this viewing
 * of the panel cleared offers an undo, and a new viewing (a remount, another session, the
 * phone going to the background) starts with none. Nothing accumulates across viewings.
 */
export interface PanelState extends SyncedState<ChangesOverview> {
  /** What this viewing asked to clear (`dismissKey`s): the only things it offers to bring back. */
  readonly clearedHere: ReadonlySet<string>;
}
export type PanelAction =
  | SyncedAction<ChangesOverview>
  /** The viewing is over without the panel going away (the phone app went to the background): drop its undo lines. */
  | { readonly type: "forgetUndo"; readonly sessionId: string };
export const initialPanel = (sessionId: string): PanelState => ({ ...initialSynced<ChangesOverview>(sessionId), clearedHere: new Set() });
export const reducePanel = (state: PanelState, action: PanelAction): PanelState => {
  if (action.type === "reset") return initialPanel(action.sessionId);
  if (action.sessionId !== state.sessionId) return state;
  if (action.type === "forgetUndo") return state.clearedHere.size === 0 ? state : { ...state, clearedHere: new Set() };
  const synced = reduceSynced(state, action);
  const clearedHere =
    action.type === "requested" && action.dismissed && !state.clearedHere.has(action.key) ? new Set(state.clearedHere).add(action.key) : state.clearedHere;
  return synced === state && clearedHere === state.clearedHere ? state : { ...synced, clearedHere };
};

/** What a request clears: the FilesChanged event at `seq` of a session (the panel spans several). */
export const dismissKey = (sessionId: string, seq: number) => `${sessionId}\0${seq}`;

export interface PanelView {
  readonly sessions: ReadonlyArray<SessionChanges>;
  /** What this viewing cleared and is still cleared, by session: each offers an undo. */
  readonly undoable: ReadonlyArray<ClearedChanges>;
  /** Whether anything is cleared at all (here, elsewhere or before): "nothing left" rather than "nothing yet". */
  readonly anyCleared: boolean;
}

/**
 * What the Changes panel shows: the server's overview with the requests in flight laid
 * over. A section whose turns are all being cleared is hidden at once (the server's answer
 * leaves them out of what it shows); what this viewing cleared, by session, offers an undo.
 */
export const panelView = (state: PanelState): PanelView | null => {
  const server = state.server;
  if (!server) return null;
  const dismissed = (sessionId: string, seq: number, onServer: boolean) => state.pending.get(dismissKey(sessionId, seq))?.dismissed ?? onServer;
  let anyCleared = false;
  const undoable = new Map<string, { sessionId: string; title: string; seqs: Array<number> }>();
  const add = (sessionId: string, title: string, seq: number) => {
    anyCleared = true;
    if (!state.clearedHere.has(dismissKey(sessionId, seq))) return;
    const entry = undoable.get(sessionId) ?? { sessionId, title, seqs: [] };
    entry.seqs.push(seq);
    undoable.set(sessionId, entry);
  };
  for (const c of server.cleared ?? []) for (const seq of c.seqs) if (dismissed(c.sessionId, seq, true)) add(c.sessionId, c.title, seq);
  const sessions = server.sessions.filter((section) => {
    const turns = section.turns ?? [];
    const clearing = turns.filter((seq) => dismissed(section.sessionId, seq, false));
    for (const seq of clearing) add(section.sessionId, section.title, seq);
    return turns.length === 0 || clearing.length < turns.length;
  });
  return { sessions, undoable: [...undoable.values()], anyCleared };
};
