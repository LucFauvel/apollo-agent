import { describe, expect, it } from "@effect/vitest";
import { unrequested } from "./requested.ts";

const turn = (...messages: Array<[string, string]>) => ({ running: true, messages: messages.map(([author, text]) => ({ author, text })) });

describe("the full diff is only for the user's request in the running turn", () => {
  it("accepts the user's own words from the turn they started, quoted loosely", () => {
    const asked = turn(["user", "Ok c'est bon. Donne-moi le  full semantic diff d'apollo-agent avant que je push."]);
    expect(unrequested(asked, "full semantic diff")).toBeNull();
    expect(unrequested(asked, "Donne-moi le full Semantic Diff")).toBeNull();
    expect(unrequested(turn(["user", "Show me “the full diff” please"]), '"the full diff"')).toBeNull();
    // A second message of the user's while the turn runs counts too.
    expect(unrequested(turn(["user", "Fix the test"], ["user", "then the full semantic diff"]), "full semantic diff")).toBeNull();
  });

  it("refuses words the user did not write in this turn, or too short a quote", () => {
    expect(unrequested(turn(["user", "Fix the failing test"]), "full semantic diff")).toContain("not in the user's message for this turn");
    expect(unrequested(turn(["user", "diff"]), "diff")).toContain("at least");
  });

  it("refuses when no turn runs, or anyone but the user started or joined it", () => {
    expect(unrequested({ running: false, messages: [] }, "full semantic diff")).toContain("no turn the user started");
    expect(unrequested(turn(), "full semantic diff")).toContain("no turn the user started");
    for (const author of ["system", "bot", "peer"]) {
      expect(unrequested(turn([author, "full semantic diff"]), "full semantic diff")).toContain(`a ${author} message`);
      expect(unrequested(turn(["user", "full semantic diff"], [author, "worker report"]), "full semantic diff")).toContain(`a ${author} message`);
    }
  });
});
