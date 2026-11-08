/**
 * The full semantic diff is for when the user asks for it, not something an agent offers on
 * its own. Its tool takes the words of the user's request, quoted from the message that
 * started the running turn, and Apollo checks they are there. A turn started (or joined) by
 * anyone but the user cannot use it, whatever an earlier message of the user's said: an
 * orchestrator's or bot's message, a worker's report, a schedule.
 *
 * What this proves is that the words are the user's, in the turn being worked on; not that
 * the user meant this action by them (a negation, or words quoted out of context, still
 * match). The tool's description carries the intent rule.
 */

/** Shortest quote accepted (after trimming), so a stray word cannot pass for a request. */
export const MIN_QUOTE = 6;

/** The running turn: the messages posted since the previous turn ended. */
export interface CurrentTurn {
  readonly running: boolean;
  readonly messages: ReadonlyArray<{ readonly author: string; readonly text: string }>;
}

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d"'`«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Why `quote` does not show the user asked in this turn, or null when it does. */
export const unrequested = (turn: CurrentTurn, quote: string): string | null => {
  if (!turn.running || turn.messages.length === 0) return "no turn the user started is running";
  const automated = turn.messages.find((m) => m.author !== "user");
  if (automated) return `this turn was not started by the user alone (a ${automated.author} message is part of it): ask the user to ask again`;
  const q = normalize(quote);
  if (q.length < MIN_QUOTE) return `\`request\` must quote the user's words asking for it (at least ${MIN_QUOTE} characters)`;
  if (!turn.messages.some((m) => normalize(m.text).includes(q))) {
    return "`request` is not in the user's message for this turn: call this only when the user asked for it there";
  }
  return null;
};
