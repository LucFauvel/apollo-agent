import type { SessionEvent, SessionId } from "@apollo/contracts";
import { describe, expect, it } from "vitest";
import { quoteLine, reduceTranscript, replyTargetIndex, toBlocks, type TranscriptState } from "../src/index.ts";

const sessionId = "ses_1" as SessionId;
const at = (seq: number, event: SessionEvent["event"]): SessionEvent => ({ sessionId, seq, at: seq, event });

const transcript = (events: ReadonlyArray<SessionEvent>) =>
  events.reduce(reduceTranscript, { sessionId, lastSeq: 0, items: [] } as TranscriptState);

describe("replies", () => {
  const state = transcript([
    at(1, { _tag: "UserMessage", text: "deploy it", author: "user" }),
    at(2, { _tag: "ToolStarted", itemId: "t1", name: "Bash", summary: "ls" }),
    at(3, { _tag: "AssistantMessage", itemId: "a1", text: "done" }),
    at(4, { _tag: "UserMessage", text: "why?", author: "user", replyTo: { seq: 3, from: "assistant", text: "done" } }),
  ]);
  const blocks = toBlocks(state.items);

  it("keeps what a message replies to on its transcript item", () => {
    expect(blocks.at(-1)).toMatchObject({ kind: "user", text: "why?", replyTo: { seq: 3, from: "assistant" } });
  });

  it("finds the block of the quoted message, user or agent", () => {
    expect(blocks[replyTargetIndex(blocks, { seq: 3 })]).toMatchObject({ kind: "assistant", text: "done" });
    expect(blocks[replyTargetIndex(blocks, { seq: 1 })]).toMatchObject({ kind: "user", text: "deploy it" });
    expect(replyTargetIndex(blocks, { seq: 2 })).toBe(-1);
    expect(replyTargetIndex(blocks, { seq: 99 })).toBe(-1);
  });

  it("quotes on one line", () => {
    expect(quoteLine("  first\n\n second  ")).toBe("first second");
  });
});
