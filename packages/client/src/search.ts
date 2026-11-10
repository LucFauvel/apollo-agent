/**
 * Search inside one conversation: case-insensitive, plain substring matching. Shared by
 * clients; what text a message shows (and so what is searched) is the client's to say,
 * since it depends on how it renders messages.
 *
 * Casing rule: each character is lowercased on its own (`toLowerCase`), and the Greek
 * final sigma ς counts as σ (so ΟΣ, ος and οσ match each other). A match always covers
 * whole characters of the text: a query that would match only part of a character's
 * lowercase form ("i" inside "İ", which lowercases to "i̇") is not a match. There is no
 * Unicode normalization or expansion (é vs e + ◌́, ß vs ss are different).
 */

/** One match: the block it is in, and which occurrence in that block's text (0-based). */
export interface SearchMatch {
  readonly key: string;
  readonly occurrence: number;
}

/** A text folded for matching, with the way back to its offsets. */
export interface FoldedText {
  readonly folded: string;
  /** For each position of `folded` (and its end): the offset in the original text. */
  readonly map: Int32Array;
  /** Whether a position of `folded` (or its end) starts a character of the original text. */
  readonly boundary: Uint8Array;
}

const foldChar = (char: string) => {
  const lower = char.toLowerCase();
  return lower === "ς" ? "σ" : lower;
};

/**
 * Folds `text` a chunk at a time: each `step(maxChars)` folds about that many more
 * characters and returns the result once the whole text is done (null until then).
 */
export const foldInSteps = (text: string) => {
  const parts: Array<string> = [];
  const map: Array<number> = [];
  const boundary: Array<number> = [];
  let i = 0;
  return {
    step(maxChars: number): FoldedText | null {
      const stop = Math.min(text.length, i + maxChars);
      while (i < stop) {
        const char = String.fromCodePoint(text.codePointAt(i)!);
        const lower = foldChar(char);
        for (let k = 0; k < lower.length; k++) {
          map.push(i);
          boundary.push(k === 0 ? 1 : 0);
        }
        parts.push(lower);
        i += char.length;
      }
      if (i < text.length) return null;
      map.push(text.length);
      boundary.push(1);
      return { folded: parts.join(""), map: Int32Array.from(map), boundary: Uint8Array.from(boundary) };
    },
  };
};

export const foldText = (text: string): FoldedText => foldInSteps(text).step(Number.POSITIVE_INFINITY)!;

/** The folded form of a query; empty when it is blank (nothing to search for). */
export const foldQuery = (query: string): string => (query.trim() ? foldText(query).folded : "");

/**
 * Where a folded query occurs in a folded text, as [start, end) offsets in the original
 * text: at most `limit` of them, and at most `maxSteps` candidate positions looked at (so
 * the work is bounded however many matches the text has).
 */
export const occurrencesIn = (
  text: FoldedText,
  needle: string,
  limit = Number.POSITIVE_INFINITY,
  maxSteps = Number.POSITIVE_INFINITY,
): Array<readonly [number, number]> => {
  const found: Array<readonly [number, number]> = [];
  if (!needle) return found;
  const { folded, map, boundary } = text;
  let steps = 0;
  for (let at = folded.indexOf(needle); at >= 0 && found.length < limit && ++steps <= maxSteps; ) {
    const end = at + needle.length;
    if (boundary[at] && boundary[end]) {
      found.push([map[at]!, map[end]!]);
      at = folded.indexOf(needle, end);
    } else at = folded.indexOf(needle, at + 1);
  }
  return found;
};

/** How many times a folded query occurs in a folded text (as `occurrencesIn` finds them). */
export const countIn = (text: FoldedText, needle: string): number => {
  if (!needle) return 0;
  const { folded, boundary } = text;
  let count = 0;
  for (let at = folded.indexOf(needle); at >= 0; ) {
    const end = at + needle.length;
    if (boundary[at] && boundary[end]) {
      count++;
      at = folded.indexOf(needle, end);
    } else at = folded.indexOf(needle, at + 1);
  }
  return count;
};

/** Where `query` occurs in `text` (case-insensitive, not overlapping), as [start, end) offsets in `text`. */
export const findOccurrences = (text: string, query: string): Array<readonly [number, number]> =>
  occurrencesIn(foldText(text), foldQuery(query));

/** A position in one of several text segments (DOM text nodes, in order). */
export interface SegmentPoint {
  readonly segment: number;
  readonly offset: number;
}

/**
 * Matches of `query` across consecutive text segments (the text nodes of a rendered
 * message), so a match split by formatting (`foo <b>bar</b>`) is still found. Linear in
 * the segments and matches: both walk forward once.
 */
export const findInSegments = (
  segments: ReadonlyArray<string>,
  query: string,
): Array<{ readonly start: SegmentPoint; readonly end: SegmentPoint }> => {
  const occurrences = findOccurrences(segments.join(""), query);
  const result: Array<{ start: SegmentPoint; end: SegmentPoint }> = [];
  // Start points: the segment holding the offset (an empty segment never holds one).
  let s = 0;
  let sBase = 0;
  // End points: the segment the offset ends in (an end at a boundary stays in the earlier segment).
  let e = 0;
  let eBase = 0;
  for (const [start, end] of occurrences) {
    while (s < segments.length - 1 && start >= sBase + segments[s]!.length) sBase += segments[s++]!.length;
    while (e < segments.length - 1 && end > eBase + segments[e]!.length) eBase += segments[e++]!.length;
    result.push({ start: { segment: s, offset: start - sBase }, end: { segment: e, offset: end - eBase } });
  }
  return result;
};

/** Matches in a conversation: per block with matches, how many, kept as running totals. */
export interface SearchResults {
  readonly total: number;
  readonly keys: ReadonlyArray<string>;
  /** `ends[i]`: matches in blocks 0..i together. */
  readonly ends: ReadonlyArray<number>;
}

export const emptyResults: SearchResults = { total: 0, keys: [], ends: [] };

/** Running totals from per-block counts (blocks in conversation order). */
export const toResults = (counts: Iterable<readonly [key: string, count: number]>): SearchResults => {
  const keys: Array<string> = [];
  const ends: Array<number> = [];
  let total = 0;
  for (const [key, count] of counts) {
    if (count <= 0) continue;
    total += count;
    keys.push(key);
    ends.push(total);
  }
  return { total, keys, ends };
};

/** The `index`-th match (0-based, conversation order), found by binary search. */
export const matchAt = (results: SearchResults, index: number): SearchMatch | null => {
  if (index < 0 || index >= results.total) return null;
  let lo = 0;
  let hi = results.ends.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (results.ends[mid]! > index) hi = mid;
    else lo = mid + 1;
  }
  const before = lo === 0 ? 0 : results.ends[lo - 1]!;
  return { key: results.keys[lo]!, occurrence: index - before };
};

/** The match after (`step` 1) or before (-1) `index`, wrapping around. */
export const stepMatch = (index: number, step: 1 | -1, count: number): number =>
  count === 0 ? 0 : (((index + step) % count) + count) % count;
