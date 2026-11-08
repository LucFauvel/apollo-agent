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

/** `changes` with one card cleared (or brought back), applied before the server confirms. */
export const withDismissed = (changes: ConversationChanges | null, seq: number, dismissed: boolean): ConversationChanges => {
  const rest = (changes?.dismissed ?? []).filter((s) => s !== seq);
  return { summaries: changes?.summaries ?? [], dismissed: dismissed ? [...rest, seq] : rest };
};
