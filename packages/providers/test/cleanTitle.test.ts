import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

/** What Claude Code was asked, and what the fake answers. */
const sdk = vi.hoisted(() => ({
  calls: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>,
  answer: "Title: **Generated title**",
  closed: 0,
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
    sdk.calls.push(args);
    return {
      close: () => void sdk.closed++,
      async *[Symbol.asyncIterator]() {
        yield { type: "result", subtype: "success", is_error: false, result: sdk.answer };
      },
    };
  },
}));

import { makeClaudeProvider } from "../src/ClaudeProvider.ts";
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
    expect(cleanTitle('  \n "" ')).toBe("");
  });
});

describe("Claude session titles", () => {
  const generate = (text: string, environment?: Record<string, string | undefined>) => {
    sdk.calls.length = 0;
    sdk.closed = 0;
    return Effect.runPromise(makeClaudeProvider().generateTitle!(text, environment));
  };

  it("sends at most the first 4,000 characters, to a small model with nothing else", async () => {
    const long = `${"a".repeat(3990)}END_OF_BOUND${"b".repeat(6000)}`;
    expect(await generate(long)).toBe("Generated title");
    expect(sdk.calls).toHaveLength(1);
    const { prompt, options } = sdk.calls[0]!;
    expect(prompt).toBe(`<message>\n${long.slice(0, 4000)}\n</message>\n\nTitle:`);
    expect(String(prompt)).not.toContain("bbbbbbbbbbbbbbbbbbbb");
    expect(options).toMatchObject({ model: "haiku", tools: [], maxTurns: 1, settingSources: [], persistSession: false });
    expect(sdk.closed).toBe(1);
  });

  it("runs on the account it is given", async () => {
    await generate("Fix the build", { CLAUDE_CONFIG_DIR: "/accounts/work" });
    expect((sdk.calls[0]!.options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe("/accounts/work");
  });

  it("fails on an empty answer, so the session keeps its opening words", async () => {
    sdk.answer = '""';
    const error = await Effect.runPromise(Effect.flip(makeClaudeProvider().generateTitle!("Anything")));
    expect(error.message).toContain("empty title");
    sdk.answer = "Title: **Generated title**";
  });

  it("is not offered on a local backend", () => {
    const local = makeClaudeProvider({ backend: { kind: "llamacpp" } as never });
    expect(local.generateTitle).toBeUndefined();
  });
});
