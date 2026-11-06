import { describe, expect, it } from "vitest";
import { sentenceFeed, speakable } from "../src/speech.ts";

const reply = `## Plan

Here is **what** I found in [the PR](https://x.y/1):

- Tests pass
- Lint *fails* on \`foo.ts\`

\`\`\`ts
const x = 1;
\`\`\`

| File | Status |
|---|---|
| a.ts | ok |

Next I'll fix it. Ready?`;

describe("speakable", () => {
  it("reads markdown as plain sentences", () => {
    expect(speakable(reply)).toBe(
      "Plan. Here is what I found in the PR: Tests pass. Lint fails on foo.ts. (code omitted). File, Status. a.ts, ok. Next I'll fix it. Ready?",
    );
  });

  it("says 'link' for bare URLs and drops images", () => {
    expect(speakable("See https://example.com/x ![chart](c.png) now.")).toBe("See link now.");
  });
});

describe("sentenceFeed", () => {
  it("hands out whole sentences while the reply streams, never half a code block", () => {
    const feed = sentenceFeed();
    const said: Array<string> = [];
    for (let i = 1; i <= reply.length; i += 5) {
      const ready = feed.next(reply.slice(0, i));
      if (ready) said.push(ready);
      // Nothing from inside the code block is spoken before it closes.
      expect(said.join(" ")).not.toContain("const x");
    }
    said.push(feed.finish(reply));
    expect(said.join(" ")).toBe(speakable(reply));
    expect(said[0]).toBe("Plan.");
  });
});
