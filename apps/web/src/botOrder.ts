import type { Bot, BotId } from "@apollo/contracts";

/**
 * The bot order, as pure functions shared by the sidebar's drag-to-reorder and the store's
 * optimistic update (tested in botOrder.test.ts; the web tests have no DOM).
 */

/**
 * Moves the item at `from` into the gap `gap` (0 = before the first item, `ids.length` =
 * after the last), as a drop indicator between rows shows it. Returns the same array when
 * nothing moves.
 */
export const moveToGap = <T>(ids: ReadonlyArray<T>, from: number, gap: number): ReadonlyArray<T> => {
  if (from < 0 || from >= ids.length || gap < 0 || gap > ids.length) return ids;
  // The gaps right above and right below the item leave it where it is.
  if (gap === from || gap === from + 1) return ids;
  const next = [...ids];
  const [item] = next.splice(from, 1);
  next.splice(gap > from ? gap - 1 : gap, 0, item!);
  return next;
};

/**
 * The gap the pointer at `y` points to, given each row's vertical extent (top to bottom):
 * above a row's middle is the gap before it, below the last row's middle is the end.
 */
export const gapAt = (rows: ReadonlyArray<{ top: number; bottom: number }>, y: number): number => {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (y < (row.top + row.bottom) / 2) return i;
  }
  return rows.length;
};

/** `bots` with positions 0..n-1 in `order` (bots not in it keep theirs, after the listed ones). */
export const withOrder = (bots: ReadonlyMap<BotId, Bot>, order: ReadonlyArray<BotId>): Map<BotId, Bot> => {
  const next = new Map(bots);
  let position = 0;
  for (const id of order) {
    const bot = next.get(id);
    if (bot) next.set(id, { ...bot, position: position++ });
  }
  const listed = new Set(order);
  for (const bot of bots.values()) {
    if (!listed.has(bot.id)) next.set(bot.id, { ...bot, position: position++ });
  }
  return next;
};

/**
 * Undoes an optimistic reorder that the server refused: each bot goes back to its position in
 * `before`, unless it changed again since `optimistic` (a push from the server is the truth).
 */
export const rollBack = (
  current: ReadonlyMap<BotId, Bot>,
  optimistic: ReadonlyMap<BotId, Bot>,
  before: ReadonlyMap<BotId, Bot>,
): Map<BotId, Bot> => {
  const next = new Map(current);
  for (const bot of current.values()) {
    const old = before.get(bot.id);
    if (old && bot.position === optimistic.get(bot.id)?.position) next.set(bot.id, { ...bot, position: old.position });
  }
  return next;
};
