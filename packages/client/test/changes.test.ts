import { describe, expect, it } from "vitest";
import {
  currentChangesKey,
  latestChangesKey,
  reduceTranscript,
  summariesByTurn,
  type TranscriptState,
  cardRequestId,
  type CardsAction,
  type CardsState,
  dismissedCards,
  initialCards,
  invalidateChanges,
  reduceCards,
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

  it("finds each turn's summary", () => {
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
  });
});

describe("clearing cards", () => {
  const A = "A";
  const B = "B";
  const server = (...dismissed: Array<number>) => ({ summaries: [], dismissed });
  const run = (state: CardsState, ...actions: Array<CardsAction>) => actions.reduce(reduceCards, state);
  const hidden = (state: CardsState) => [...dismissedCards(state)].sort((a, b) => a - b);

  it("hides a card at once, and keeps it hidden until a fetch issued after the server accepted it", () => {
    const id = cardRequestId();
    let s = run(initialCards(A), { type: "fetched", sessionId: A, epoch: 0, changes: server() });
    s = run(s, { type: "requested", sessionId: A, id, seq: 7, dismissed: true });
    expect(hidden(s)).toEqual([7]);
    expect(s.justCleared.has(7)).toBe(true);
    s = run(s, { type: "settled", sessionId: A, id, seq: 7, ok: true });
    // An answer to a fetch issued before that does not bring the card back...
    s = run(s, { type: "fetched", sessionId: A, epoch: 0, changes: server() });
    expect(hidden(s)).toEqual([7]);
    // ...one issued after it is the truth.
    s = run(s, { type: "fetched", sessionId: A, epoch: s.epoch, changes: server(7) });
    expect(s.pending.size).toBe(0);
    expect(hidden(s)).toEqual([7]);
  });

  it("never lets a failed request overwrite what the server said since", () => {
    // A clears 7; B clears it too, and A learns it from a refetch; then A's request fails.
    const id = cardRequestId();
    let s = run(initialCards(A), { type: "fetched", sessionId: A, epoch: 0, changes: server() });
    s = run(
      s,
      { type: "requested", sessionId: A, id, seq: 7, dismissed: true },
      { type: "fetched", sessionId: A, epoch: 0, changes: server(7) },
      { type: "settled", sessionId: A, id, seq: 7, ok: false },
    );
    expect(hidden(s)).toEqual([7]);
    // The same for an undo that fails while the server still has the card cleared.
    const undo = cardRequestId();
    s = run(s, { type: "requested", sessionId: A, id: undo, seq: 7, dismissed: false });
    expect(hidden(s)).toEqual([]);
    s = run(s, { type: "settled", sessionId: A, id: undo, seq: 7, ok: false });
    expect(hidden(s)).toEqual([7]);
    // Every settled request moves the epoch, which refetches.
    expect(s.epoch).toBe(2);
  });

  it("drops answers to older fetches, and a request superseded by a newer one", () => {
    let s = run(initialCards(A), { type: "fetched", sessionId: A, epoch: 3, changes: server(1) });
    s = run(s, { type: "fetched", sessionId: A, epoch: 2, changes: server() });
    expect(hidden(s)).toEqual([1]);
    const first = cardRequestId();
    const second = cardRequestId();
    s = run(
      s,
      { type: "requested", sessionId: A, id: first, seq: 4, dismissed: true },
      { type: "requested", sessionId: A, id: second, seq: 4, dismissed: false },
      { type: "settled", sessionId: A, id: first, seq: 4, ok: false },
    );
    expect(s.pending.get(4)?.id).toBe(second);
    expect(hidden(s)).toEqual([1]);
  });

  it("ignores a late answer or request outcome for another session", () => {
    // Undo started in A; the user switched to B, where card 7 is not cleared; A's request fails.
    const id = cardRequestId();
    let s = run(initialCards(A), { type: "requested", sessionId: A, id, seq: 7, dismissed: false });
    s = run(s, { type: "reset", sessionId: B }, { type: "fetched", sessionId: B, epoch: 0, changes: server() });
    const before = s;
    s = run(
      s,
      { type: "settled", sessionId: A, id, seq: 7, ok: false },
      { type: "requested", sessionId: A, id: cardRequestId(), seq: 7, dismissed: true },
      { type: "fetched", sessionId: A, epoch: 9, changes: server(7) },
    );
    expect(s).toBe(before);
    expect(hidden(s)).toEqual([]);
  });

  it("counts a reconnect as a change for every bot, even ones never heard from", () => {
    const next = invalidateChanges(new Map([["old", 4]]), ["old", "new"]);
    expect([...next]).toEqual([
      ["old", 5],
      ["new", 1],
    ]);
  });
});
