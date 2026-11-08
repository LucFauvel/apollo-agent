import type { AgentEvent, Bot, Session } from "@apollo/contracts";
import { describe, expect, it } from "vitest";
import * as Database from "../Database.ts";
import { CLIENT_SESSION_TTL_MS, makePairing } from "../auth/Auth.ts";
import { makePushTokens, notificationFor, plain } from "./Push.ts";

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

describe("who gets push notifications", () => {
  /** One Apollo install: its own database, pairings and push tokens. */
  const install = () => {
    const db = Database.open(":memory:");
    const pairing = makePairing(db);
    const pair = (label: string, now?: number) => {
      const { sessionToken } = pairing.redeem(pairing.createPairingToken(label, now).token, label, now)!;
      return pairing.authenticate(sessionToken, now)!;
    };
    return { pairing, tokens: makePushTokens(db), pair };
  };

  it("sends only to phones paired with this computer", () => {
    const mine = install();
    const someoneElse = install();
    const phone = mine.pair("My phone");
    const theirPhone = someoneElse.pair("Their phone");
    mine.tokens.register("ExponentPushToken[mine]", phone.id, "ios");
    someoneElse.tokens.register("ExponentPushToken[theirs]", theirPhone.id, "ios");
    expect(mine.tokens.active()).toEqual(["ExponentPushToken[mine]"]);
    expect(someoneElse.tokens.active()).toEqual(["ExponentPushToken[theirs]"]);
  });

  it("drops tokens of unknown, revoked and expired clients", () => {
    const { pairing, tokens, pair } = install();
    const now = 10_000_000;
    tokens.register("ExponentPushToken[never-paired]", "client-that-does-not-exist", "ios", now);
    const revoked = pair("Old phone", now);
    tokens.register("ExponentPushToken[revoked]", revoked.id, "ios", now);
    pairing.revokeClient(revoked.id, now);
    const idle = pair("Idle phone", now);
    tokens.register("ExponentPushToken[idle]", idle.id, "ios", now);
    const active = pair("Phone", now);
    tokens.register("ExponentPushToken[active]", active.id, "ios", now);
    expect([...tokens.active(now + 1)].sort()).toEqual(["ExponentPushToken[active]", "ExponentPushToken[idle]"]);
    expect(tokens.active(now + CLIENT_SESSION_TTL_MS + 1)).toEqual([]);
  });

  it("notifies when an agent hands the browser over", () => {
    expect(
      notificationFor(session(), bot, { _tag: "BrowserHandoff", requestId: "r", tabId: "t", url: "https://x.y", reason: "Log in to **Messenger**" }, null),
    ).toMatchObject({ kind: "handoff", title: "Atlas needs you in the browser", body: "Log in to Messenger" });
  });
});
