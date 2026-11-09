import { describe, expect, it } from "vitest";
import { findInSegments, findOccurrences, matchAt, stepMatch, toResults } from "../src/index.ts";

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
    expect(findOccurrences("anything", " \n\t")).toEqual([]);
  });

  it("keeps offsets right when lowercasing changes a string's length", () => {
    // "İ" lowercases to two code units: the match after it must still point at the original text.
    const text = "İstanbul Search";
    const [[start, end]] = findOccurrences(text, "search") as [[number, number]];
    expect(text.slice(start, end)).toBe("Search");
    expect(findOccurrences("A😀B", "😀")).toEqual([[1, 3]]);
  });

  it("numbers matches across blocks in conversation order", () => {
    const results = toResults([
      ["u1", 1],
      ["t1", 0],
      ["a1", 2],
    ]);
    expect(results.total).toBe(3);
    expect([0, 1, 2, 3].map((i) => matchAt(results, i))).toEqual([
      { key: "u1", occurrence: 0 },
      { key: "a1", occurrence: 0 },
      { key: "a1", occurrence: 1 },
      null,
    ]);
  });

  it("finds a match split across text nodes", () => {
    const [match] = findInSegments(["say foo ", "ba", "r now"], "foo bar");
    expect(match).toEqual({ start: { segment: 0, offset: 4 }, end: { segment: 2, offset: 1 } });
    // A match that ends exactly at a segment's end stays in that segment.
    expect(findInSegments(["ab", "cd"], "ab")).toEqual([{ start: { segment: 0, offset: 0 }, end: { segment: 0, offset: 2 } }]);
    // One that starts exactly at a segment boundary begins in the next segment.
    expect(findInSegments(["ab", "", "cd"], "cd")).toEqual([{ start: { segment: 2, offset: 0 }, end: { segment: 2, offset: 2 } }]);
    expect(findInSegments(["fo", "o ", "bar"], "o b")).toEqual([{ start: { segment: 1, offset: 0 }, end: { segment: 2, offset: 1 } }]);
  });

  it("steps through matches, wrapping both ways", () => {
    expect(stepMatch(0, 1, 3)).toBe(1);
    expect(stepMatch(2, 1, 3)).toBe(0);
    expect(stepMatch(0, -1, 3)).toBe(2);
    expect(stepMatch(0, 1, 0)).toBe(0);
  });
});

describe("reviewer round 1 repros (search logic)", () => {
  it("reviewer round 1 repro: every counted match covers a non-empty range of whole characters (İ vs i)", () => {
    for (const [text, query] of [
      ["İ", "i"],
      ["İstanbul", "i"],
      ["xİy", "İ"],
      ["ﬁne", "fi"],
    ] as const) {
      for (const [start, end] of findOccurrences(text, query)) {
        expect(end).toBeGreaterThan(start);
        // The matched slice, lowercased, is what was searched for: no partial characters.
        expect(text.slice(start, end).toLowerCase()).toBe(query.toLowerCase());
      }
    }
    expect(findOccurrences("İ", "i")).toEqual([]);
    expect(findOccurrences("xİy", "İ")).toEqual([[1, 2]]);
  });

  it("reviewer round 1 repro: contextual final sigma matches (ΟΣ vs ος)", () => {
    expect(findOccurrences("ΟΣ", "ος")).toEqual([[0, 2]]);
    expect(findOccurrences("ΟΔΟΣ ΟΔΟΣ", "οδος")).toEqual([
      [0, 4],
      [5, 9],
    ]);
    expect(findOccurrences("σοφος", "ΣΟΦΟΣ")).toEqual([[0, 5]]);
  });

  it("reviewer round 1 repro: mapping matches onto text nodes is linear, not quadratic", () => {
    const nodes = Array<string>(64_000).fill("a ");
    const started = performance.now();
    const found = findInSegments(nodes, "a");
    const elapsed = performance.now() - started;
    expect(found).toHaveLength(64_000);
    expect(found[63_999]).toEqual({ start: { segment: 63_999, offset: 0 }, end: { segment: 63_999, offset: 1 } });
    // Quadratic lookup took ~1.4 s here; linear takes a few ms.
    expect(elapsed).toBeLessThan(250);
  });
});
