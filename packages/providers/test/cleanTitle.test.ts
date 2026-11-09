import { describe, expect, it } from "@effect/vitest";
import { cleanTitle } from "../src/Provider.ts";

describe("cleanTitle", () => {
  it("keeps the first line without quotes, labels or end punctuation", () => {
    expect(cleanTitle('"Fix flaky login tests."')).toBe("Fix flaky login tests");
    expect(cleanTitle("\n\nTitle: **Passkey rollout plan**\nMore text")).toBe("Passkey rollout plan");
    expect(cleanTitle("« Revue du PKCE » !")).toBe("Revue du PKCE");
  });

  it("shortens long titles at a word boundary", () => {
    expect(cleanTitle("one two three four five six seven", 20)).toBe("one two three four…");
    expect(cleanTitle("supercalifragilisticexpialidocious", 10)).toBe("supercalif…");
  });

  it("gives an empty string for an empty answer", () => {
    expect(cleanTitle("  \n \"\" ")).toBe("");
  });
});
