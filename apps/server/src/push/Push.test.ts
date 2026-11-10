import type { AgentEvent, Bot, BotId, Session, SessionId } from "@apollo/contracts";
import { describe, expect, it } from "vitest";
import * as Database from "../Database.ts";
import { CLIENT_SESSION_TTL_MS, makePairing } from "../auth/Auth.ts";
import { failedToStart, makePushTokens, makeTurnNotices, notificationFor, OWN_NOTICE_WINDOW_MS, plain, type Waiting } from "./Push.ts";

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
    expect(
      notificationFor(session({ role: "worker", parentSessionId: "s1" } as Partial<Session>), bot, { _tag: "TurnCompleted", outcome: "failed", error: "boom" }, null),
    ).toBeNull();
  });

  it("still tells the user when a spawned worker needs them", () => {
    const worker = session({ role: "worker", parentSessionId: "s1", title: "Fix CI" } as Partial<Session>);
    expect(notificationFor(worker, bot, { _tag: "ApprovalRequested", requestId: "r", title: "Run tests", detail: "" }, null)).toMatchObject({
      kind: "approval",
      title: "Fix CI · Atlas needs your approval",
    });
    expect(
      notificationFor(worker, bot, { _tag: "InputRequested", requestId: "r", source: "Claude", message: "Which branch?", url: null, fields: [] }, null),
    ).toMatchObject({ kind: "question" });
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

describe("finished turns while work is pending", () => {
  const timing = { settleMs: 1_000, graceMs: 10_000, sweepMs: 100, jobCapMs: 600_000 };
  const id = "s1" as SessionId;
  const botId = "b1" as BotId;
  const idle: Waiting = { busy: false, workers: 0, jobs: 0, botReplies: 0, answeredBot: false };
  const finished = notificationFor(session(), bot, done, "Worker started, I'll report back.")!;
  const at = (w: Partial<Waiting> = {}) => new Map([[id, { ...idle, ...w }]]);
  /** Ends a turn and sweeps from `t0` for `ms` (every 100 ms); returns what went out, and when. */
  const run = (turns: ReturnType<typeof makeTurnNotices>, waiting: (t: number) => Map<SessionId, Waiting | null>, t0: number, ms: number) => {
    const out: Array<{ t: number; body: string }> = [];
    for (let t = t0; t <= t0 + ms; t += 100) for (const d of turns.sweep(t, waiting(t))) out.push({ t, body: d.note.body });
    return out;
  };

  it("notifies once nothing is pending", () => {
    const turns = makeTurnNotices(timing);
    expect(turns.offer(id, botId, finished)).toBeNull(); // held, briefly
    expect(run(turns, () => at(), 0, 5_000)).toEqual([{ t: 1_000, body: finished.body }]);
    expect(turns.held()).toEqual([]);
  });

  it.each([
    ["a worker it spawned", { workers: 1 }],
    ["a background job", { jobs: 1 }],
    ["another bot's answer", { botReplies: 1 }],
  ])("holds the notice while %s is pending", (_, pending) => {
    const turns = makeTurnNotices(timing);
    turns.offer(id, botId, finished);
    expect(run(turns, () => at(pending), 0, 60_000)).toEqual([]);
    expect(turns.held()).toEqual([id]);
  });

  it("lets a notice wait on background jobs alone only up to the cap", () => {
    const turns = makeTurnNotices(timing);
    turns.offer(id, botId, finished, 0);
    expect(run(turns, () => at({ jobs: 1 }), 0, 599_900)).toEqual([]);
    expect(run(turns, () => at({ jobs: 1 }), 600_000, 0)).toEqual([{ t: 600_000, body: finished.body }]);
    expect(turns.held()).toEqual([]);
  });

  it("does not cap a notice that also waits on a worker or another bot", () => {
    for (const pending of [{ workers: 1 }, { botReplies: 1 }]) {
      const turns = makeTurnNotices(timing);
      turns.offer(id, botId, finished, 0);
      expect(run(turns, () => at({ jobs: 1, ...pending }), 0, 1_200_000)).toEqual([]);
      expect(turns.held()).toEqual([id]);
    }
  });

  it("sends a capped notice once: the job ending later does not repeat it", () => {
    const turns = makeTurnNotices(timing);
    turns.offer(id, botId, finished, 0);
    expect(run(turns, () => at({ jobs: 1 }), 0, 600_000)).toHaveLength(1);
    // The job ends at 15 min without waking the session (no grace-period repeat either)…
    expect(run(turns, (t) => at({ jobs: t < 900_000 ? 1 : 0 }), 600_100, 600_000)).toEqual([]);
    // …or it reports, and the turn that starts decides for itself.
    turns.turnStarted(id);
    const report = { ...finished, body: "The build passed." };
    turns.offer(id, botId, report, 1_300_000);
    expect(run(turns, () => at(), 1_300_000, 5_000)).toEqual([{ t: 1_301_000, body: report.body }]);
  });

  it("notifies the follow-up turn once the work is done, not the one that waited", () => {
    const turns = makeTurnNotices(timing);
    turns.offer(id, botId, finished);
    expect(run(turns, () => at({ workers: 1 }), 0, 30_000)).toEqual([]);
    // The worker reports: a new turn starts, and its end is what the user hears about.
    expect(run(turns, () => at({ busy: true }), 30_100, 2_000)).toEqual([]);
    turns.turnStarted(id);
    const report = { ...finished, body: "The worker fixed CI: all tests pass." };
    turns.offer(id, botId, report);
    expect(run(turns, () => at(), 40_000, 30_000)).toEqual([{ t: 41_000, body: report.body }]);
  });

  it("holds a turn that ends while the next is about to start (a message came in)", () => {
    const turns = makeTurnNotices(timing);
    turns.offer(id, botId, finished);
    expect(run(turns, () => at({ busy: true }), 0, 500)).toEqual([]);
    turns.turnStarted(id);
    expect(turns.held()).toEqual([]);
  });

  it("notifies anyway when the work ends without waking the session", () => {
    const turns = makeTurnNotices(timing);
    turns.offer(id, botId, finished);
    // The worker dies at 5 s and never reports: after the grace period, the user hears.
    const out = run(turns, (t) => at({ workers: t < 5_000 ? 1 : 0 }), 0, 60_000);
    expect(out).toEqual([{ t: 15_000, body: finished.body }]);
  });

  it("passes approvals, questions and errors through at once, even with work pending", () => {
    const turns = makeTurnNotices(timing);
    const approval = notificationFor(session(), bot, { _tag: "ApprovalRequested", requestId: "r", title: "Push", detail: "" }, null)!;
    const question = notificationFor(session(), bot, { _tag: "InputRequested", requestId: "r", source: "C", message: "Which?", url: null, fields: [] }, null)!;
    const error = notificationFor(session(), bot, { _tag: "TurnCompleted", outcome: "failed", error: "boom" }, null)!;
    turns.offer(id, botId, finished);
    for (const note of [approval, question, error]) expect(turns.offer(id, botId, note)).toBe(note);
    expect(turns.held()).toEqual([id]); // (the finished turn alone is held)
  });

  it("stays quiet for a turn that answered another bot, and for a session that is gone", () => {
    const turns = makeTurnNotices(timing);
    turns.offer(id, botId, finished);
    expect(run(turns, () => at({ answeredBot: true }), 0, 5_000)).toEqual([]);
    expect(turns.held()).toEqual([]);
    turns.offer(id, botId, finished);
    expect(run(turns, () => new Map([[id, null]]), 0, 5_000)).toEqual([]);
    expect(turns.held()).toEqual([]);
  });

  it("lets a bot's own notification about a finished turn stand in for the turn's notice", () => {
    // A scheduled heartbeat: its turn ends (held), then the scheduler sends the result itself.
    const turns = makeTurnNotices(timing);
    turns.offer(id, botId, finished, 0);
    turns.notifiedAfterTurn(id, 200);
    expect(turns.held()).toEqual([]);
    expect(run(turns, () => at(), 0, 5_000)).toEqual([]);
    // The scheduler's notification is handled first (the two streams race): the turn's is dropped.
    turns.turnStarted(id);
    turns.notifiedAfterTurn(id, 10_000);
    expect(turns.offer(id, botId, finished, 10_050)).toBeNull();
    expect(turns.held()).toEqual([]);
    // Only once, and not much later: the next turn is announced as usual.
    turns.offer(id, botId, finished, 11_000);
    expect(turns.held()).toEqual([id]);
    turns.turnStarted(id);
    turns.notifiedAfterTurn(id, 20_000);
    turns.offer(id, botId, finished, 20_000 + OWN_NOTICE_WINDOW_MS);
    expect(turns.held()).toEqual([id]);
    // A new turn forgets it, too.
    turns.turnStarted(id);
    turns.notifiedAfterTurn(id, 40_000);
    turns.turnStarted(id);
    turns.offer(id, botId, finished, 40_100);
    expect(turns.held()).toEqual([id]);
  });

  it("does not let a notification stand in for errors, approvals or questions", () => {
    const turns = makeTurnNotices(timing);
    const error = notificationFor(session(), bot, { _tag: "TurnCompleted", outcome: "failed", error: "boom" }, null)!;
    turns.notifiedAfterTurn(id, 0);
    expect(turns.offer(id, botId, error, 10)).toBe(error);
  });
});

describe("providers that fail to start", () => {
  const errored = session({ status: "error" } as Partial<Session>);
  it("counts a turn under way that ends in error", () => {
    expect(failedToStart("running", errored)).toBe(true);
    expect(failedToStart("waiting-approval", errored)).toBe(true);
  });
  it("ignores other changes, and processes opening for something else", () => {
    expect(failedToStart("starting", errored)).toBe(false);
    expect(failedToStart(undefined, errored)).toBe(false);
    expect(failedToStart("error", errored)).toBe(false);
    expect(failedToStart("running", session({ status: "idle" } as Partial<Session>))).toBe(false);
  });
  it("says so like a failed turn", () => {
    expect(notificationFor(errored, bot, { _tag: "TurnCompleted", outcome: "failed", error: "claude: not logged in" }, null)).toEqual({
      kind: "error",
      title: "Atlas stopped with an error",
      body: "claude: not logged in",
    });
  });
});
