/**
 * The full semantic diff is for when the user asks for it, not something an agent offers on
 * its own. Its tool takes the words of the user's request, quoted from their latest message,
 * and Apollo checks they are there: an agent cannot call it from a turn the user did not ask
 * in (a worker's report, a schedule, an orchestrator's message).
 */

/** Shortest quote accepted (after trimming), so a stray word cannot pass for a request. */
export const MIN_QUOTE = 6;

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’“”"'`«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Why `quote` does not show the user asked, or null when their message contains it. */
export const unrequested = (message: string | null, quote: string): string | null => {
  const q = normalize(quote);
  if (message === null) return "the user has not written in this conversation";
  if (q.length < MIN_QUOTE) return `\`request\` must quote the user's words asking for it (at least ${MIN_QUOTE} characters)`;
  if (!normalize(message).includes(q)) return "`request` is not in the user's latest message: call this only when the user asked for it there";
  return null;
};
