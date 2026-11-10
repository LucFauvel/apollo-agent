import type { SessionEvent, SessionId } from "@apollo/contracts";
import { reduceTranscript, replyTargetIndex, toBlocks, type TranscriptState } from "@apollo/client";
import { describe, expect, it } from "vitest";
import { dayIndexOf, groupByDay } from "./components/DayGroups.tsx";

const sessionId = "ses_1" as SessionId;
const DAY = 24 * 60 * 60 * 1000;
const monday = new Date(2026, 10, 2, 12).getTime();

describe("jumping to the message a reply quotes", () => {
  it("finds the earlier day to open when the quoted message is in it", () => {
    const events: Array<SessionEvent> = [
      { sessionId, seq: 1, at: monday, event: { _tag: "UserMessage", text: "plan it", author: "user" } },
      { sessionId, seq: 2, at: monday + 1000, event: { _tag: "AssistantMessage", itemId: "a1", text: "here is the plan" } },
      { sessionId, seq: 3, at: monday + DAY, event: { _tag: "UserMessage", text: "next", author: "user" } },
      {
        sessionId,
        seq: 4,
        at: monday + 2 * DAY,
        event: { _tag: "UserMessage", text: "about that plan", author: "user", replyTo: { seq: 2, from: "assistant", text: "here is the plan" } },
      },
    ];
    const state = events.reduce(reduceTranscript, { sessionId, lastSeq: 0, items: [] } as TranscriptState);
    const blocks = toBlocks(state.items);
    const days = groupByDay(blocks);
    expect(days).toHaveLength(3);
    const target = blocks[replyTargetIndex(blocks, { seq: 2 })]!;
    expect(dayIndexOf(days, target.key)).toBe(0);
    expect(dayIndexOf(days, "missing")).toBe(-1);
  });
});
