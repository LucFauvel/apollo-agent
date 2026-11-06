import type { AgentEvent, Bot, Session } from "@apollo/contracts";
import { describe, expect, it } from "vitest";
import { notificationFor, plain } from "./Push.ts";

const session = (over: Partial<Session> = {}) =>
  ({ id: "s1", botId: "b1", role: "main", parentSessionId: null, title: "Main", ...over }) as unknown as Session;
const bot = { id: "b1", name: "Atlas" } as unknown as Bot;
const done: AgentEvent = { _tag: "TurnCompleted", outcome: "completed", error: null };

describe("push notifications", () => {
  it("says who needs what", () => {
    expect(notificationFor(session(), bot, { _tag: "ApprovalRequested", requestId: "r", title: "Run `rm -rf build`", detail: "" }, null)).toEqual({
      kind: "approval",
      title: "Atlas needs your approval",
      body: "Run rm -rf build",
    });
    expect(
      notificationFor(session(), bot, { _tag: "InputRequested", requestId: "r", source: "Claude", message: "Which **branch**?", url: null, fields: [] }, null),
    ).toMatchObject({ kind: "question", title: "Atlas has a question", body: "Which branch?" });
    expect(notificationFor(session(), bot, { _tag: "SecretRequested", requestId: "r", label: "GitHub token", reason: "", placeholder: null }, null)).toMatchObject({
      kind: "secret",
      body: "GitHub token",
    });
    expect(notificationFor(session(), bot, done, "## Done\n\nAll **tests** pass.")).toEqual({ kind: "done", title: "Atlas", body: "Done All tests pass." });
    expect(notificationFor(session({ role: "worker", parentSessionId: null, title: "Fix CI" } as Partial<Session>), bot, done, "ok")?.title).toBe(
      "Fix CI · Atlas",
    );
  });

  it("stays quiet for silent, stopped, reflection and spawned-worker turns", () => {
    expect(notificationFor(session(), bot, done, "[SILENT]")).toBeNull();
    expect(notificationFor(session(), bot, { _tag: "TurnCompleted", outcome: "interrupted", error: null }, "x")).toBeNull();
    expect(notificationFor(session({ role: "reflection" } as Partial<Session>), bot, done, "x")).toBeNull();
    expect(notificationFor(session({ role: "worker", parentSessionId: "s1" } as Partial<Session>), bot, done, "x")).toBeNull();
  });

  it("strips markdown for the body", () => {
    expect(plain("See [the PR](https://x.y/1) and ```\ncode\n``` `here`")).toBe("See the PR and here");
  });
});
