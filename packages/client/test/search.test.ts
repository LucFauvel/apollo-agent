import { describe, expect, it } from "vitest";
import {
  findInSegments,
  findMatches,
  findOccurrences,
  markdownPlainText,
  searchableText,
  stepMatch,
  toBlocks,
  type TranscriptItem,
} from "../src/index.ts";

const user = (key: string, text: string, author = "user"): TranscriptItem =>
  ({ kind: "user", key, text, author, seq: 1 }) as unknown as TranscriptItem;
const said = (key: string, text: string): TranscriptItem => ({ kind: "assistant", key, text, streaming: false, seq: 2 }) as unknown as TranscriptItem;
const tool = (key: string, output: string): TranscriptItem =>
  ({ kind: "tool", key, name: "Bash", summary: output, output, isError: false }) as unknown as TranscriptItem;

describe("conversation search", () => {
  it("matches case-insensitively, without overlaps", () => {
    expect(findOccurrences("Passkey, PASSKEY and passkeys", "passkey")).toEqual([
      [0, 7],
      [9, 16],
      [21, 28],
    ]);
    expect(findOccurrences("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it("finds nothing for an empty or blank query", () => {
    expect(findOccurrences("anything", "")).toEqual([]);
    expect(findMatches(toBlocks([said("1", "hello")]), "   ")).toEqual([]);
  });

  it("keeps offsets right when lowercasing changes a string's length", () => {
    // "İ" lowercases to two code units: the match after it must still point at the original text.
    const text = "İstanbul Search";
    const [[start, end]] = findOccurrences(text, "search") as [[number, number]];
    expect(text.slice(start, end)).toBe("Search");
  });

  it("searches every message of the conversation in order, skipping tool activity", () => {
    const blocks = toBlocks([user("u1", "Deploy the API"), tool("t1", "api deployed"), said("a1", "The **API** is up. Check the API logs."), user("u2", "thanks")]);
    expect(findMatches(blocks, "api")).toEqual([
      { key: "u1", occurrence: 0 },
      { key: "a1", occurrence: 0 },
      { key: "a1", occurrence: 1 },
    ]);
  });

  it("matches rendered markdown, not its syntax or link targets", () => {
    expect(markdownPlainText("## Title\n- **bold** and `code`\n> [the docs](https://example.com/x)")).toBe("Title\nbold and code\nthe docs");
    const blocks = toBlocks([said("a1", "See [the docs](https://example.com/docs) for **foo bar**.")]);
    expect(findMatches(blocks, "example.com")).toEqual([]);
    expect(findMatches(blocks, "foo bar")).toEqual([{ key: "a1", occurrence: 0 }]);
  });

  it("searches system messages whole and skips silent runs", () => {
    const blocks = toBlocks([user("s1", "[Apollo] Worker finished\nIt fixed the **login** bug", "system"), said("a1", "[SILENT]")]);
    expect(searchableText(blocks[0]!)).toBe("Worker finished\nIt fixed the login bug");
    expect(searchableText(blocks[1]!)).toBeNull();
    expect(findMatches(blocks, "login")).toEqual([{ key: "s1", occurrence: 0 }]);
  });

  it("finds a match split across text nodes", () => {
    const [match] = findInSegments(["say foo ", "ba", "r now"], "foo bar");
    expect(match).toEqual({ start: { segment: 0, offset: 4 }, end: { segment: 2, offset: 1 } });
    // A match that ends exactly at a segment's end stays in that segment.
    expect(findInSegments(["ab", "cd"], "ab")).toEqual([{ start: { segment: 0, offset: 0 }, end: { segment: 0, offset: 2 } }]);
    // One that starts exactly at a segment boundary begins in the next segment.
    expect(findInSegments(["ab", "", "cd"], "cd")).toEqual([{ start: { segment: 2, offset: 0 }, end: { segment: 2, offset: 2 } }]);
  });

  it("steps through matches, wrapping both ways", () => {
    expect(stepMatch(0, 1, 3)).toBe(1);
    expect(stepMatch(2, 1, 3)).toBe(0);
    expect(stepMatch(0, -1, 3)).toBe(2);
    expect(stepMatch(0, 1, 0)).toBe(0);
  });
});
