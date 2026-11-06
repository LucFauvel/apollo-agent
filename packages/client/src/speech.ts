/**
 * Turning an agent's markdown into something a voice can read, for the desktop and
 * phone apps' read-aloud and voice conversation modes.
 */

/** Markdown to plain spoken text: code, tables, links and markup become words or go away. */
export const speakable = (markdown: string): string =>
  markdown
    // Code blocks are not read out; say there is one.
    .replace(/```[\s\S]*?(```|$)/g, " (code omitted) ")
    // Tables: drop the divider rows, read cells separated by commas.
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}.*$/gm, "")
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => `${row.split("|").map((c) => c.trim()).filter(Boolean).join(", ")}.`)
    // Images are skipped; links read as their text, bare URLs as "link".
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    // Inline code keeps its text.
    .replace(/`([^`]+)`/g, "$1")
    // Headings, quotes, list markers, emphasis, rules.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gm, "$1.")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]*)?/gm, "")
    .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    // A line break ends a sentence when nothing else does.
    .replace(/([^.!?:;,\s])\s*\n+/g, "$1.\n")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\.{2,}(?!\.)/g, ".")
    .trim();

/** Where the text can be cut so that everything before it is complete sentences. */
const lastBoundary = (text: string): number => {
  // Never cut inside an unfinished code block.
  const fences = [...text.matchAll(/```/g)];
  const limit = fences.length % 2 === 1 ? fences.at(-1)!.index : text.length;
  let cut = 0;
  for (const m of text.slice(0, limit).matchAll(/[.!?…](?=\s)|:\s*\n|\n\s*\n|```\s*\n/g)) cut = m.index + m[0].length;
  return cut;
};

/**
 * Feeds a reply that is still streaming to a voice, one batch of finished sentences at
 * a time. `next(text)` takes the whole text so far and returns what is newly ready to
 * say (or ""); `finish(text)` returns whatever is left once the reply is complete.
 */
export const sentenceFeed = () => {
  let spoken = 0;
  return {
    next(text: string): string {
      const cut = lastBoundary(text);
      if (cut <= spoken) return "";
      const chunk = text.slice(spoken, cut);
      spoken = cut;
      return speakable(chunk);
    },
    finish(text: string): string {
      const rest = text.slice(spoken);
      spoken = text.length;
      return speakable(rest);
    },
  };
};
