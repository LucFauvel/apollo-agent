/**
 * Search inside one conversation: case-insensitive, plain substring matching over the
 * messages a client shows. Runs on the transcript the client already holds (it replays a
 * session's whole log), so folded days and collapsed messages are searched too.
 */
import type { TranscriptBlock } from "./activity.ts";
import { systemMessageParts } from "./activity.ts";

/** One match: the block it is in, and which occurrence in that block's text (0-based). */
export interface SearchMatch {
  readonly key: string;
  readonly occurrence: number;
}

/**
 * Markdown as it reads once rendered, closely enough for counting matches: link and image
 * targets dropped, emphasis, code and heading/list/quote markers removed.
 */
export const markdownPlainText = (markdown: string): string =>
  markdown
    .split("\n")
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*(?:>\s?)+/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ""),
    )
    .join("\n")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, "$1")
    .replace(/`+([^`\n]*)`+/g, "$1");

/** The text search looks at in a block, as shown; null when search skips the block (tool activity, cards). */
export const searchableText = (block: TranscriptBlock): string | null => {
  switch (block.kind) {
    case "user":
      if (block.author === "user") return block.text;
      if (block.author === "peer") return markdownPlainText(block.text);
      {
        const { first, body } = systemMessageParts(block.text);
        return body ? `${first}\n${markdownPlainText(body)}` : first;
      }
    case "assistant":
      return !block.streaming && block.text.trim() === "[SILENT]" ? null : markdownPlainText(block.text);
    case "notice":
      return block.message;
    default:
      return null;
  }
};

/** Lowercases `text` and maps each position of the result back to one in `text`. */
const fold = (text: string) => {
  let folded = "";
  const map: Array<number> = [];
  for (let i = 0; i < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(i)!);
    const lower = char.toLowerCase();
    for (let k = 0; k < lower.length; k++) map.push(i);
    folded += lower;
    i += char.length;
  }
  map.push(text.length);
  return { folded, map };
};

/** Where `query` occurs in `text` (case-insensitive, not overlapping), as [start, end) offsets in `text`. */
export const findOccurrences = (text: string, query: string): Array<readonly [number, number]> => {
  if (!query.trim()) return [];
  const needle = fold(query).folded;
  const { folded, map } = fold(text);
  const found: Array<readonly [number, number]> = [];
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
    found.push([map[at]!, map[at + needle.length]!]);
  }
  return found;
};

/** Every match of `query` in a conversation, in order. */
export const findMatches = (blocks: ReadonlyArray<TranscriptBlock>, query: string): Array<SearchMatch> => {
  const matches: Array<SearchMatch> = [];
  if (!query.trim()) return matches;
  for (const block of blocks) {
    const text = searchableText(block);
    if (text === null) continue;
    const count = findOccurrences(text, query).length;
    for (let occurrence = 0; occurrence < count; occurrence++) matches.push({ key: block.key, occurrence });
  }
  return matches;
};

/** A position in one of several text segments (DOM text nodes, in order). */
export interface SegmentPoint {
  readonly segment: number;
  readonly offset: number;
}

/**
 * Matches of `query` across consecutive text segments (the text nodes of a rendered
 * message), so a match split by formatting (`foo <b>bar</b>`) is still found.
 */
export const findInSegments = (
  segments: ReadonlyArray<string>,
  query: string,
): Array<{ readonly start: SegmentPoint; readonly end: SegmentPoint }> => {
  const starts: Array<number> = [];
  let total = 0;
  for (const segment of segments) {
    starts.push(total);
    total += segment.length;
  }
  const locate = (offset: number, isEnd: boolean): SegmentPoint => {
    // An end lands at the end of a segment rather than the start of the next one.
    let segment = 0;
    for (let i = 0; i < starts.length; i++) {
      if (isEnd ? starts[i]! < offset : starts[i]! <= offset) segment = i;
      else break;
    }
    // Skip empty segments a start would otherwise land on.
    while (!isEnd && segment < segments.length - 1 && offset - starts[segment]! >= segments[segment]!.length) segment++;
    return { segment, offset: offset - starts[segment]! };
  };
  return findOccurrences(segments.join(""), query).map(([start, end]) => ({ start: locate(start, false), end: locate(end, true) }));
};

/** The match after (`step` 1) or before (-1) `index`, wrapping around. */
export const stepMatch = (index: number, step: 1 | -1, count: number): number =>
  count === 0 ? 0 : (((index + step) % count) + count) % count;
