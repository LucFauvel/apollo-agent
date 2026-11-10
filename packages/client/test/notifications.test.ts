import { describe, expect, it } from "vitest";
import { seenNotifications, withSeenMark } from "../src/index.ts";

describe("dismissing notifications of seen chats", () => {
  const marks = new Map([["atlas", 1_000]]);
  const n = (id: string, botId: string | undefined, at?: number, receivedAt?: number) => ({ id, botId, at, receivedAt });

  it("dismisses a bot's notifications sent up to when its chats were seen", () => {
    const delivered = [n("a1", "atlas", 500), n("a2", "atlas", 1_000), n("a3", "atlas", 1_001)];
    expect(seenNotifications(delivered, marks).map((x) => x.id)).toEqual(["a1", "a2"]);
  });

  it("keeps other bots' notifications, and ones it cannot place", () => {
    const delivered = [n("v1", "vega", 10), n("x1", undefined, 10), n("a1", "atlas"), n("a2", "atlas", undefined, 900)];
    // (No server time: when it arrived on this device stands in.)
    expect(seenNotifications(delivered, marks).map((x) => x.id)).toEqual(["a2"]);
    expect(seenNotifications(delivered, new Map())).toEqual([]);
  });

  it("goes by when the server sent it, not by this device's clock", () => {
    // This device's clock runs 5 minutes behind the server's; the user saw Atlas at 1_000 (server time).
    const skew = -300_000;
    const before = n("before", "atlas", 900, 900 + skew);
    const after = n("after", "atlas", 1_100, 1_100 + skew);
    expect(seenNotifications([before, after], marks).map((x) => x.id)).toEqual(["before"]);
    // Ahead instead: a notification sent after the mark still stays.
    expect(seenNotifications([n("ahead", "atlas", 1_100, 1_100 + 300_000)], marks)).toEqual([]);
  });

  it("keeps the latest mark per bot", () => {
    const later = withSeenMark(marks, "atlas", 2_000);
    expect(later.get("atlas")).toBe(2_000);
    expect(withSeenMark(later, "atlas", 1_500)).toBe(later);
    expect(withSeenMark(later, "vega", 5).get("vega")).toBe(5);
  });
});
