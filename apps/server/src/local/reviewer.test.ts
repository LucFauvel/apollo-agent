import { describe, expect, it } from "@effect/vitest";
import { parseVerdict, reviewMessages } from "./Reviewer.ts";

describe("reviewer model", () => {
  it("only allows on a clear ALLOW", () => {
    expect(parseVerdict("ALLOW")).toBe("allow");
    expect(parseVerdict(" allow.")).toBe("allow");
    expect(parseVerdict("<think>maybe ALLOW</think>ASK")).toBe("ask");
    expect(parseVerdict("I think this is fine")).toBe("ask");
    expect(parseVerdict("")).toBe("ask");
  });

  it("gives the model the call, the working folder and what the user asked", () => {
    const [, user] = reviewMessages({ tool: "Bash", input: { command: "ls" }, cwd: "/w", task: "list files" });
    expect(user!.content).toContain("Working folder: /w");
    expect(user!.content).toContain("What the user asked: list files");
    expect(user!.content).toContain('Input: {"command":"ls"}');
  });
});
