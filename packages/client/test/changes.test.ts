import { describe, expect, it } from "vitest";
import {
  currentChangesKey,
  latestChangesKey,
  reduceTranscript,
  summariesByTurn,
  type TranscriptState,
  cardsTick,
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
  /** Sends a fetch for `sessionId`: the action to dispatch now, and its answer for later. */
  const fetchFor = (sessionId: string) => {
    const fetchId = cardsTick();
    return {
      sent: { type: "fetching", sessionId, fetchId } as const,
      answer: (...dismissed: Array<number>) => ({ type: "fetched", sessionId, fetchId, changes: server(...dismissed) }) as const,
    };
  };
  const settled = (sessionId: string, id: number, seq: number, ok: boolean) =>
    ({ type: "settled", sessionId, id, seq, ok, tick: cardsTick() }) as const;
  const loaded = (sessionId: string, ...dismissed: Array<number>) => {
    const f = fetchFor(sessionId);
    return run(initialCards(sessionId), f.sent, f.answer(...dismissed));
  };

  it("hides a card at once, and keeps it hidden until a fetch sent after the server accepted it", () => {
    let s = loaded(A);
    const before = fetchFor(A);
    s = run(s, before.sent);
    const id = cardsTick();
    s = run(s, { type: "requested", sessionId: A, id, seq: 7, dismissed: true });
    expect(hidden(s)).toEqual([7]);
    expect(s.justCleared.has(7)).toBe(true);
    s = run(s, settled(A, id, 7, true));
    // The settle started a fetch; an answer sent before the acceptance must not bring the card back.
    const after = fetchFor(A);
    s = run(s, before.answer(), after.sent);
    expect(hidden(s)).toEqual([7]);
    s = run(s, after.answer(7));
    expect(s.pending.size).toBe(0);
    expect(hidden(s)).toEqual([7]);
  });

  it("keeps the accepted overlay when the newest fetch was sent before the acceptance", () => {
    // Reviewer race: the only fetch in flight predates the server taking the request.
    let s = loaded(A);
    const id = cardsTick();
    const early = fetchFor(A);
    s = run(s, { type: "requested", sessionId: A, id, seq: 7, dismissed: true }, early.sent, settled(A, id, 7, true), early.answer());
    expect(hidden(s)).toEqual([7]);
    const late = fetchFor(A);
    s = run(s, late.sent, late.answer(7));
    expect(s.pending.size).toBe(0);
  });

  it("never lets a failed request overwrite what the server said since", () => {
    // A clears 7; B clears it too, and A learns it from a refetch; then A's request fails.
    const start = loaded(A);
    const id = cardsTick();
    const refetch = fetchFor(A);
    let s = run(
      start,
      { type: "requested", sessionId: A, id, seq: 7, dismissed: true },
      refetch.sent,
      refetch.answer(7),
      settled(A, id, 7, false),
    );
    expect(hidden(s)).toEqual([7]);
    // The same for an undo that fails while the server still has the card cleared.
    const undo = cardsTick();
    s = run(s, { type: "requested", sessionId: A, id: undo, seq: 7, dismissed: false });
    expect(hidden(s)).toEqual([]);
    s = run(s, settled(A, undo, 7, false));
    expect(hidden(s)).toEqual([7]);
    // Every settled request moves the epoch, which refetches.
    expect(s.epoch).toBe(2);
  });

  it("applies only the answer to the newest fetch, whatever started each and in whatever order they return", () => {
    // Two reads in flight, e.g. one from mount and one from a ChangesUpdated: the newer returns first.
    const older = fetchFor(A);
    const newer = fetchFor(A);
    let s = run(initialCards(A), older.sent, newer.sent, newer.answer(7), older.answer());
    expect(hidden(s)).toEqual([7]);
    // And the other way round: the older answer is dropped, the newer applies.
    const third = fetchFor(A);
    const fourth = fetchFor(A);
    s = run(s, third.sent, fourth.sent, third.answer(), fourth.answer(7, 8));
    expect(hidden(s)).toEqual([7, 8]);
  });

  it("forgets a previous visit's fetches on returning to a session, and lets the new visit's apply", () => {
    // A -> B -> A, leaving with a read in flight that would say 7 is cleared.
    const visit = loaded(A);
    const id = cardsTick();
    const leftBehind = fetchFor(A);
    let s = run(visit, { type: "requested", sessionId: A, id, seq: 7, dismissed: true }, settled(A, id, 7, true), leftBehind.sent);
    expect(s.latestFetch).toBe(leftBehind.sent.fetchId);
    s = run(s, { type: "reset", sessionId: B }, { type: "reset", sessionId: A });
    // Its answer lands before this visit sent anything, and after: dropped both times.
    s = run(s, leftBehind.answer(7));
    expect(s.server).toBe(null);
    const fresh = fetchFor(A);
    s = run(s, fresh.sent, leftBehind.answer(7));
    expect(s.server).toBe(null);
    s = run(s, fresh.answer());
    expect(hidden(s)).toEqual([]);
    // A later read (a reconnect, say) still applies: nothing is wedged.
    const reconnect = fetchFor(A);
    s = run(s, reconnect.sent, reconnect.answer(9));
    expect(hidden(s)).toEqual([9]);
  });

  it("converges for two superseding requests under every outcome and order", () => {
    for (const firstValue of [true, false])
      for (const firstOk of [true, false])
        for (const secondOk of [true, false])
          for (const order of [
            [1, 2],
            [2, 1],
          ]) {
            const ids = [cardsTick(), cardsTick()] as const;
            let s = loaded(A);
            let serverValue = false;
            s = run(
              s,
              { type: "requested", sessionId: A, id: ids[0], seq: 7, dismissed: firstValue },
              { type: "requested", sessionId: A, id: ids[1], seq: 7, dismissed: !firstValue },
            );
            for (const n of order) {
              const ok = n === 1 ? firstOk : secondOk;
              if (ok) serverValue = n === 1 ? firstValue : !firstValue;
              s = run(s, settled(A, ids[n - 1]!, 7, ok));
            }
            const f = fetchFor(A);
            s = run(s, f.sent, f.answer(...(serverValue ? [7] : [])));
            expect(dismissedCards(s).has(7)).toBe(serverValue);
            expect(s.pending.size).toBe(0);
          }
  });

  it("drops a request superseded by a newer one for the same card", () => {
    const first = cardsTick();
    const second = cardsTick();
    const s = run(
      loaded(A, 1),
      { type: "requested", sessionId: A, id: first, seq: 4, dismissed: true },
      { type: "requested", sessionId: A, id: second, seq: 4, dismissed: false },
      settled(A, first, 4, false),
    );
    expect(s.pending.get(4)?.id).toBe(second);
    expect(hidden(s)).toEqual([1]);
  });

  it("ignores a late answer or request outcome for another session", () => {
    // Undo started in A; the user switched to B, where card 7 is not cleared; A's request fails.
    const id = cardsTick();
    const inA = fetchFor(A);
    let s = run(initialCards(A), { type: "requested", sessionId: A, id, seq: 7, dismissed: false }, inA.sent);
    s = run(s, { type: "reset", sessionId: B });
    const inB = fetchFor(B);
    s = run(s, inB.sent, inB.answer());
    const before = s;
    s = run(s, settled(A, id, 7, false), { type: "requested", sessionId: A, id: cardsTick(), seq: 7, dismissed: true }, inA.answer(7));
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
