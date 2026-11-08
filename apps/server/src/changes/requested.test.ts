import { describe, expect, it } from "@effect/vitest";
import { unrequested } from "./requested.ts";

describe("the full diff is only for the user's request", () => {
  it("accepts the user's own words, quoted loosely", () => {
    const message = "Ok c'est bon. Donne-moi le  full semantic diff d'apollo-agent avant que je push.";
    expect(unrequested(message, "full semantic diff")).toBeNull();
    expect(unrequested(message, "Donne-moi le full Semantic Diff")).toBeNull();
    expect(unrequested("Show me “the full diff” please", '"the full diff"')).toBeNull();
  });

  it("refuses words the user did not write, too short a quote, or no message", () => {
    expect(unrequested("Fix the failing test", "full semantic diff")).toContain("not in the user's latest message");
    expect(unrequested("diff", "diff")).toContain("at least");
    expect(unrequested(null, "full semantic diff")).toContain("has not written");
  });
});
