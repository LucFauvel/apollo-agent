import { describe, expect, it } from "vitest";
import {
  currentChangesKey,
  latestChangesKey,
  reduceTranscript,
  summariesByTurn,
  type TranscriptState,
  withDismissed,
} from "../src/index.ts";
import type { AgentEvent, SessionEvent, SessionId } from "@apollo/contracts";

const sessionId = "s1" as SessionId;
const at = (seq: number, event: AgentEvent): SessionEvent => ({ sessionId, seq, at: seq * 1000, event }) as SessionEvent;
const repos = [{ repo: "/r/app", name: "app", files: [{ path: "a.ts", oldPath: null, status: "modified" as const, additions: 1, deletions: 0 }] }];

const replay = (events: ReadonlyArray<SessionEvent>) =>
  events.reduce<TranscriptState>(reduceTranscript, { sessionId, lastSeq: 0, items: [] }).items;

describe("conversation changes cards", () => {
  it("ties each card to its event and the turn that made it", () => {
    const items = replay([
      at(1, { _tag: "UserMessage", text: "do it", author: "user" }),
      at(2, { _tag: "TurnStarted" }),
      at(3, { _tag: "FilesChanged", repos }),
      at(4, { _tag: "UserMessage", text: "again", author: "user" }),
      at(5, { _tag: "TurnStarted" }),
      at(6, { _tag: "FilesChanged", repos }),
    ]);
    const cards = items.flatMap((i) => (i.kind === "changes" ? [[i.key, i.seq, i.turnSeq]] : []));
    expect(cards).toEqual([
      ["c3", 3, 2],
      ["c6", 6, 5],
    ]);
  });

  it("keeps only the latest turn's card open, until a new turn starts", () => {
    const user = (key: string) => ({ kind: "user", key });
    const card = (key: string) => ({ kind: "changes", key });
    const said = (key: string) => ({ kind: "assistant", key });
    expect(currentChangesKey([user("u1"), card("c1"), user("u2"), card("c2"), said("a2")])).toBe("c2");
    // The next turn started: the last card is history now.
    expect(currentChangesKey([user("u1"), card("c1"), said("a1"), user("u2"), said("a2")])).toBe(null);
    expect(latestChangesKey([user("u1"), card("c1"), user("u2"), said("a2")])).toBe("c1");
    expect(currentChangesKey([])).toBe(null);
  });

  it("finds each turn's summary and applies a cleared card before the server confirms", () => {
    const changes = {
      summaries: [
        { turnSeq: 5, text: "newer", at: 3 },
        { turnSeq: 5, text: "older", at: 2 },
        { turnSeq: 2, text: "first", at: 1 },
      ],
      dismissed: [3],
    };
    expect([...summariesByTurn(changes)]).toEqual([
      [5, "newer"],
      [2, "first"],
    ]);
    expect(summariesByTurn(null).size).toBe(0);
    expect(withDismissed(changes, 6, true).dismissed).toEqual([3, 6]);
    expect(withDismissed(changes, 3, false).dismissed).toEqual([]);
    expect(withDismissed(null, 3, true)).toEqual({ summaries: [], dismissed: [3] });
  });
});
