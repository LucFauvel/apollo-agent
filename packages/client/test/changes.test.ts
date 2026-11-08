import { describe, expect, it } from "vitest";
import {
  currentChangesKey,
  hasCards,
  isFullDiff,
  withoutFullDiffs,
  latestChangesKey,
  reduceTranscript,
  summariesByTurn,
  type TranscriptState,
  cardsTick,
  dismissKey,
  initialCards,
  initialPanel,
  invalidateChanges,
  panelView,
  reduceCards,
  reducePanel,
  type PanelAction,
  type PanelState,
} from "../src/index.ts";
import type { AgentEvent, ChangesOverview, SessionEvent, SessionId } from "@apollo/contracts";

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

  it("keeps full diffs out of the turn cards", () => {
    const report = {
      gitDir: "/r/app/.git",
      base: { ref: "main", commit: "abc", tree: "t0" },
      head: { branch: "feature", commit: "def", tree: "t1" },
      commitCount: 0,
      commits: [],
      uncommitted: true,
      moreFiles: 0,
      additions: 1,
      deletions: 0,
      notes: [],
    };
    const items = replay([
      at(1, { _tag: "UserMessage", text: "do it", author: "user" }),
      at(2, { _tag: "TurnStarted" }),
      at(3, { _tag: "FilesChanged", repos }),
      at(4, { _tag: "UserMessage", text: "full semantic diff", author: "user" }),
      at(5, { _tag: "TurnStarted" }),
      at(6, { _tag: "FilesChanged", repos, report }),
    ]);
    const full = items.find((i) => i.kind === "changes" && i.seq === 6)!;
    expect(isFullDiff(full)).toBe(true);
    expect(items.filter(isFullDiff).map((i) => i.key)).toEqual(["c6"]);
    // The full diff takes neither the latest turn's place nor the folding generation.
    const turns = withoutFullDiffs(items);
    expect(currentChangesKey(turns)).toBe(null);
    expect(latestChangesKey(turns)).toBe("c3");
    // Only turns' cards need their summaries loaded: a full diff alone does not.
    expect(hasCards(withoutFullDiffs(items))).toBe(true);
    expect(hasCards(withoutFullDiffs(items.filter(isFullDiff)))).toBe(false);
  });

  it("shows every card, whatever was cleared from the Changes panel", () => {
    // The server still lists cleared FilesChanged events (older clients hide their cards); the
    // cards' state only carries the summaries.
    const fetchId = cardsTick();
    let s = reduceCards(initialCards(sessionId), { type: "fetching", sessionId, fetchId });
    s = reduceCards(s, { type: "fetched", sessionId, fetchId, changes: { summaries: [{ turnSeq: 2, text: "done", at: 1 }], dismissed: [3, 6] } });
    expect([...summariesByTurn(s.server)]).toEqual([[2, "done"]]);
    expect(s.pending.size).toBe(0);
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

describe("clearing turns from the Changes panel", () => {
  const A = "A";
  const B = "B";
  /** Worker W's section shows turns 7 and 9 (FilesChanged seqs); `cleared` lists W's cleared ones. */
  const server = (...cleared: Array<number>): ChangesOverview => {
    const shown = [7, 9].filter((seq) => !cleared.includes(seq));
    return {
      sessions: shown.length
        ? [
            {
              sessionId: "W",
              title: "worker",
              repos: [{ repo: "/r", name: "r", files: [{ path: "a.ts", oldPath: null, status: "modified", additions: 1, deletions: 0, note: null }] }],
              summaries: [],
              updatedAt: 1,
              turns: shown,
            },
          ]
        : [],
      cleared: cleared.length ? [{ sessionId: "W", title: "worker", seqs: cleared }] : [],
    };
  };
  const run = (state: PanelState, ...actions: Array<PanelAction>) => actions.reduce(reducePanel, state);
  /** What the panel shows: W's section or not, and what it offers to bring back. */
  const shows = (state: PanelState) => {
    const view = panelView(state)!;
    return { section: view.sessions.length > 0, cleared: view.cleared.flatMap((c) => c.seqs).sort((a, b) => a - b) };
  };
  const fetchFor = (sessionId: string) => {
    const fetchId = cardsTick();
    return {
      sent: { type: "fetching", sessionId, fetchId } as const,
      answer: (...cleared: Array<number>) => ({ type: "fetched", sessionId, fetchId, changes: server(...cleared) }) as const,
    };
  };
  const key = (seq: number) => dismissKey("W", seq);
  const requested = (sessionId: string, id: number, seq: number, dismissed: boolean) => ({ type: "requested", sessionId, id, key: key(seq), dismissed }) as const;
  const settled = (sessionId: string, id: number, seq: number, ok: boolean) => ({ type: "settled", sessionId, id, key: key(seq), ok, tick: cardsTick() }) as const;
  const loaded = (sessionId: string, ...cleared: Array<number>) => {
    const f = fetchFor(sessionId);
    return run(initialPanel(sessionId), f.sent, f.answer(...cleared));
  };
  /** Clears both of W's turns, as the section's cross does. */
  const clearSection = (state: PanelState, sessionId: string) => {
    const ids = [cardsTick(), cardsTick()] as const;
    return { ids, state: run(state, requested(sessionId, ids[0], 7, true), requested(sessionId, ids[1], 9, true)) };
  };

  it("hides a section at once and offers it back, until a fetch sent after the server accepted it", () => {
    let s = loaded(A);
    expect(shows(s)).toEqual({ section: true, cleared: [] });
    const before = fetchFor(A);
    s = run(s, before.sent);
    const { ids, state } = clearSection(s, A);
    s = state;
    expect(shows(s)).toEqual({ section: false, cleared: [7, 9] });
    s = run(s, settled(A, ids[0], 7, true), settled(A, ids[1], 9, true));
    // An answer sent before the acceptance must not bring the section back.
    const after = fetchFor(A);
    s = run(s, before.answer(), after.sent);
    expect(shows(s)).toEqual({ section: false, cleared: [7, 9] });
    s = run(s, after.answer(7, 9));
    expect(s.pending.size).toBe(0);
    expect(shows(s)).toEqual({ section: false, cleared: [7, 9] });
  });

  it("keeps a section shown while only some of its turns are being cleared", () => {
    const s = run(loaded(A), requested(A, cardsTick(), 7, true));
    expect(shows(s)).toEqual({ section: true, cleared: [7] });
  });

  it("takes the undo line away at once, and shows the section again from the server's answer", () => {
    let s = loaded(A, 7, 9);
    expect(shows(s)).toEqual({ section: false, cleared: [7, 9] });
    const ids = [cardsTick(), cardsTick()] as const;
    s = run(s, requested(A, ids[0], 7, false), requested(A, ids[1], 9, false));
    expect(shows(s)).toEqual({ section: false, cleared: [] });
    s = run(s, settled(A, ids[0], 7, true), settled(A, ids[1], 9, true));
    const f = fetchFor(A);
    s = run(s, f.sent, f.answer());
    expect(shows(s)).toEqual({ section: true, cleared: [] });
    expect(s.epoch).toBe(2);
  });

  it("never lets a failed request overwrite what the server said since", () => {
    // A clears the section; another device clears it too, and A learns it; then A's requests fail.
    const { ids, state } = clearSection(loaded(A), A);
    const refetch = fetchFor(A);
    let s = run(state, refetch.sent, refetch.answer(7, 9), settled(A, ids[0], 7, false), settled(A, ids[1], 9, false));
    expect(shows(s)).toEqual({ section: false, cleared: [7, 9] });
    // The same for an undo that fails while the server still has them cleared.
    const undo = cardsTick();
    s = run(s, requested(A, undo, 7, false));
    expect(shows(s)).toEqual({ section: false, cleared: [9] });
    s = run(s, settled(A, undo, 7, false));
    expect(shows(s)).toEqual({ section: false, cleared: [7, 9] });
  });

  it("applies only the answer to the newest fetch, whatever order they return in", () => {
    const older = fetchFor(A);
    const newer = fetchFor(A);
    let s = run(initialPanel(A), older.sent, newer.sent, newer.answer(7, 9), older.answer());
    expect(shows(s)).toEqual({ section: false, cleared: [7, 9] });
    const third = fetchFor(A);
    const fourth = fetchFor(A);
    s = run(s, third.sent, fourth.sent, third.answer(7, 9), fourth.answer());
    expect(shows(s)).toEqual({ section: true, cleared: [] });
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
            s = run(s, requested(A, ids[0], 7, firstValue), requested(A, ids[1], 7, !firstValue));
            for (const n of order) {
              const ok = n === 1 ? firstOk : secondOk;
              if (ok) serverValue = n === 1 ? firstValue : !firstValue;
              s = run(s, settled(A, ids[n - 1]!, 7, ok));
            }
            const f = fetchFor(A);
            s = run(s, f.sent, f.answer(...(serverValue ? [7] : [])));
            expect(shows(s).cleared.includes(7)).toBe(serverValue);
            expect(s.pending.size).toBe(0);
          }
  });

  it("forgets another view's fetches and requests: a late answer or outcome for it is ignored", () => {
    const { ids, state } = clearSection(loaded(A), A);
    const inA = fetchFor(A);
    let s = run(state, inA.sent, { type: "reset", sessionId: B });
    const inB = fetchFor(B);
    s = run(s, inB.sent, inB.answer());
    const before = s;
    s = run(s, settled(A, ids[0], 7, false), requested(A, cardsTick(), 9, false), inA.answer(7, 9));
    expect(s).toBe(before);
    expect(shows(s)).toEqual({ section: true, cleared: [] });
  });

  it("forgets a previous visit's fetches on returning to a session, and lets the new visit's apply", () => {
    // A -> B -> A, leaving with a read in flight that would say W's turns are cleared.
    const leftBehind = fetchFor(A);
    let s = run(loaded(A), leftBehind.sent, { type: "reset", sessionId: B }, { type: "reset", sessionId: A });
    s = run(s, leftBehind.answer(7, 9));
    expect(s.server).toBe(null);
    const fresh = fetchFor(A);
    s = run(s, fresh.sent, leftBehind.answer(7, 9));
    expect(s.server).toBe(null);
    s = run(s, fresh.answer());
    expect(shows(s)).toEqual({ section: true, cleared: [] });
    const reconnect = fetchFor(A);
    s = run(s, reconnect.sent, reconnect.answer(9));
    expect(shows(s)).toEqual({ section: true, cleared: [9] });
  });

  it("keys requests by session: the same seq in two sessions are two things", () => {
    expect(dismissKey("W", 7)).not.toBe(dismissKey("X", 7));
    const s = run(loaded(A), { type: "requested", sessionId: A, id: cardsTick(), key: dismissKey("X", 7), dismissed: true });
    expect(shows(s)).toEqual({ section: true, cleared: [] });
  });

  it("shows nothing before the first answer, and takes an older server's overview as is", () => {
    expect(panelView(initialPanel(A))).toBe(null);
    const f = fetchFor(A);
    const old = server();
    const { cleared: _, ...withoutCleared } = old;
    const legacy = { sessions: old.sessions.map(({ turns: __, ...section }) => section) } satisfies typeof withoutCleared;
    const s = run(initialPanel(A), f.sent, { type: "fetched", sessionId: A, fetchId: f.sent.fetchId, changes: legacy });
    expect(panelView(s)).toEqual({ sessions: legacy.sessions, cleared: [] });
  });
});

describe("refetching", () => {
  it("counts a reconnect as a change for every bot, even ones never heard from", () => {
    const next = invalidateChanges(new Map([["old", 4]]), ["old", "new"]);
    expect([...next]).toEqual([
      ["old", 5],
      ["new", 1],
    ]);
  });
});
