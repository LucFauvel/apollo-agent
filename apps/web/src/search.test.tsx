import { findInSegments, foldQuery, toBlocks, type TranscriptItem } from "@apollo/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownText } from "./components/Code.tsx";
import { JumpTracker, type JumpState, opensSearch, paintAndJump, type PaintScheduler, showSearchMatches, type ShortcutEvent } from "./components/ConversationSearch.tsx";
import { conversationMatches, locateMatch, prepareSearch, searchTexts } from "./search.ts";
import { type SearchPort, SearchClient } from "./searchClient.ts";
import { type FromIndex, SearchIndex, type ToIndex } from "./searchIndex.ts";

type TranscriptBlockLike = Record<string, unknown>;
const markdownShownTextFor = (item: TranscriptItem) => searchTexts(toBlocks([item])[0]!)![0]!;
const said = (key: string, text: string): TranscriptItem => ({ kind: "assistant", key, text, streaming: false, seq: 2 }) as unknown as TranscriptItem;

/** How many matches search counts for one assistant message. */
const counted = (text: string, query: string) => conversationMatches(toBlocks([said("m", text)]), foldQuery(query)).total;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

/** The text nodes the browser shows for some rendered HTML, minus what search skips (`data-search-skip`). */
const shownTextNodes = (html: string) => {
  const nodes: Array<string> = [];
  const skipping: Array<boolean> = [];
  for (const [token] of html.matchAll(/<[^>]+>|[^<]+/g)) {
    if (token.startsWith("</")) skipping.pop();
    else if (token.startsWith("<")) {
      const name = /^<([a-zA-Z0-9-]+)/.exec(token)?.[1]?.toLowerCase() ?? "";
      if (!VOID.has(name) && !token.endsWith("/>")) skipping.push((skipping.at(-1) ?? false) || token.includes("data-search-skip"));
    } else if (!(skipping.at(-1) ?? false)) nodes.push(decode(token));
  }
  return nodes;
};

/** How many matches the user sees highlighted (and can jump to) in the rendered message. */
const shown = (text: string, query: string) => findInSegments(shownTextNodes(renderToStaticMarkup(<MarkdownText>{text}</MarkdownText>)), query).length;

describe("reviewer round 1 repros (search in the rendered conversation)", () => {
  it("reviewer round 1 repro: the counted matches are the ones the rendered message shows", () => {
    const cases: Array<readonly [string, string]> = [
      ["```js\n**foo**\n```", "**foo**"],
      ["a &amp; b", "amp"],
      ["a &amp; b", "&"],
      ["_hello_ hello", "_hello_"],
      ["_hello_ hello", "hello"],
      ["![kitten](https://example.com/cat.png)", "kitten"],
      ["![foo](https://example.com/img) foo", "foo"],
      ["| a | b |\n| - | - |\n| cat | dog |", "catdog"],
      ["foo\n\nbar foo\nbar", "foo\nbar"],
      ["`**foo**` foo", "foo"],
      ["`**foo**` foo", "**foo**"],
      ["[foo **bar**](https://example.com)", "foo bar"],
      ["[the docs](https://example.com/docs)", "example.com"],
      ["Visit https://example.com/x today", "example.com"],
      ["## Title\n\n- item one\n- [x] done", "item"],
      ["snake_case_name and *em*", "snake_case"],
      ["```ts\nconst a = 1;\nconst b = 2;\n```", "const"],
      // A code block's language label and Copy button are not content.
      ["```ts\ncopy(x)\n```", "copy"],
      ["```ts\ncopy(x)\n```", "ts"],
      ["> quoted **text**\n\n1. first\n2. second", "quoted text"],
    ];
    for (const [text, query] of cases) {
      expect({ text, query, count: counted(text, query) }).toEqual({ text, query, count: shown(text, query) });
    }
  });
});

let rangesBuilt = 0;
const fakePage = () => {
  rangesBuilt = 0;
  class FakeHighlight {
    readonly ranges: Array<unknown> = [];
    constructor(...ranges: Array<unknown>) {
      this.ranges.push(...ranges);
    }
    add(range: unknown) {
      this.ranges.push(range);
      return this;
    }
  }
  const registry = new Map<string, FakeHighlight>();
  const rect = (top: number) => ({ top, bottom: top + 20, height: 20, left: 0, right: 100, width: 100 });
  Object.assign(globalThis, {
    CSS: { highlights: registry },
    Highlight: FakeHighlight,
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    document: {
      createTreeWalker: (root: { nodes: Array<unknown> }) => {
        let i = 0;
        return { nextNode: () => root.nodes[i++] ?? null };
      },
      createRange: () => {
        rangesBuilt++;
        return { setStart() {}, setEnd() {}, getBoundingClientRect: () => rect(0) };
      },
    },
  });
  return { registry, rect };
};
/** Message i (text `text(i)`) sits at i × 20 px; the viewport shows 0–400 px. */
const container = (count: number, text: (i: number) => string, rect: (top: number) => object) => {
  const elements = Array.from({ length: count }, (_, i) => ({
    getAttribute: () => String(i),
    nodes: [{ data: text(i), parentElement: { closest: () => null } }],
    getBoundingClientRect: () => rect(i * 20),
  }));
  return {
    querySelectorAll: () => elements,
    getBoundingClientRect: () => ({ top: 0, bottom: 400, height: 400, left: 0, right: 100, width: 100 }),
    scrollTo() {},
    scrollTop: 0,
    clientHeight: 400,
  } as unknown as HTMLElement;
};


describe("reviewer round 1 repros (highlighting at scale)", () => {
  afterEach(() => {
    for (const key of ["CSS", "Highlight", "NodeFilter", "document"]) Reflect.deleteProperty(globalThis, key);
  });

  it("reviewer round 1 repro: 5,000 mounted messages × 30 matches neither throw nor build every range", () => {
    const { registry, rect } = fakePage();
    const page = container(5000, () => "a ".repeat(30), rect);
    expect(() => showSearchMatches(page, "a", { key: "4999", occurrence: 29, element: 0, start: 58, end: 59, paintFrom: 0 }, true)).not.toThrow();
    // The current match is always highlighted; the rest only around what is on screen.
    expect(registry.get("conversation-search-current")?.ranges).toHaveLength(1);
    expect(rangesBuilt).toBeLessThan(5000);
  });

  it("reviewer round 1 repro: one visible message with 100,000 matches paints a bounded number of them", () => {
    const { registry, rect } = fakePage();
    const page = container(1, () => "a ".repeat(100_000), rect);
    expect(() => showSearchMatches(page, "a", { key: "0", occurrence: 99_999, element: 0, start: 199_998, end: 199_999, paintFrom: 197_998 }, false)).not.toThrow();
    expect(registry.get("conversation-search-current")?.ranges).toHaveLength(1);
    // A fixed bound, not the constant itself (so raising it to "everything" fails here).
    expect(registry.get("conversation-search")!.ranges.length).toBeLessThanOrEqual(5000);
    expect(rangesBuilt).toBeLessThanOrEqual(5001);
  });
});

const key = (over: Partial<ShortcutEvent>): ShortcutEvent => ({
  key: "f",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  target: null,
  ...over,
});
const page = (modal: boolean) => ({ querySelector: (selector: string) => (modal && selector.includes("aria-modal") ? {} : null) }) as unknown as ParentNode;

describe("reviewer round 1 repros (find shortcut)", () => {
  it("reviewer round 1 repro: Cmd/Ctrl+F is left alone while a dialog is open", () => {
    const inDialog = { closest: (selector: string) => (selector.includes("dialog") ? {} : null) } as unknown as EventTarget;
    expect(opensSearch(key({ target: inDialog }), page(true))).toBe(false);
    expect(opensSearch(key({}), page(true))).toBe(false);
    expect(opensSearch(key({ ctrlKey: true, metaKey: false }), page(true))).toBe(false);
    // Something else already handled it.
    expect(opensSearch(key({ defaultPrevented: true }), page(false))).toBe(false);
  });

  it("opens search with Cmd/Ctrl+F otherwise, and only then", () => {
    expect(opensSearch(key({}), page(false))).toBe(true);
    expect(opensSearch(key({ key: "F", ctrlKey: true, metaKey: false }), page(false))).toBe(true);
    expect(opensSearch(key({ shiftKey: true }), page(false))).toBe(false);
    expect(opensSearch(key({ key: "g" }), page(false))).toBe(false);
    expect(opensSearch(key({ metaKey: false }), page(false))).toBe(false);
  });
});

describe("search at scale", () => {
  const conversation = (n: number) =>
    toBlocks(Array.from({ length: n }, (_, i) => said(`m${i}`, `Answer ${i}: the **API** is up, see \`api.log\` and [the API docs](https://example.com/api). ${"a ".repeat(30)}`)));

  // Building and first-counting 5,000 messages can exceed vitest's 5 s default on a
  // loaded CI runner; the per-query budgets asserted below are what this test is about.
  it("counts 5,000 messages once, then answers new queries and streamed updates from its cache", () => {
    const blocks = conversation(5000);
    let started = performance.now();
    expect(conversationMatches(blocks, foldQuery("a")).total).toBeGreaterThan(150_000);
    const first = performance.now() - started;

    started = performance.now();
    expect(conversationMatches(blocks, foldQuery("api")).total).toBe(5000 * 3);
    const keystroke = performance.now() - started;

    // The link target is not shown, so not counted: 3 per message.
    // A streamed token replaces the last message only.
    const updated = [...blocks.slice(0, -1), said("m4999", "the API grew")] as typeof blocks;
    started = performance.now();
    expect(conversationMatches(updated, foldQuery("api")).total).toBe(4999 * 3 + 1);
    const stream = performance.now() - started;

    console.info(`search scale: first ${first.toFixed(0)} ms, new query ${keystroke.toFixed(0)} ms, stream update ${stream.toFixed(0)} ms`);
    expect(keystroke).toBeLessThan(250);
    expect(stream).toBeLessThan(50);
  }, 30_000);

  it("prepares a long conversation a slice at a time", () => {
    const blocks = conversation(400);
    let clock = 0;
    // Each clock read advances 1 ms: an 8 ms budget stops long before 400 messages.
    const now = () => clock++;
    let slices = 1;
    while (!prepareSearch(blocks, 8, now)) slices++;
    expect(slices).toBeGreaterThan(2);
    // Once prepared, nothing is left to do.
    expect(prepareSearch(blocks, 0, now)).toBe(true);
  });

  it("searches a system message's first line and body as the page shows them, and skips silent runs", () => {
    const system = { kind: "user", key: "s1", text: "[Apollo] Worker finished\nIt fixed the **login** bug", author: "system", seq: 1 } as unknown as TranscriptItem;
    const blocks = toBlocks([system, said("a1", "[SILENT]")]);
    expect(conversationMatches(blocks, foldQuery("login")).total).toBe(1);
    expect(conversationMatches(blocks, foldQuery("**login**")).total).toBe(0);
    expect(conversationMatches(blocks, foldQuery("silent")).total).toBe(0);
  });
});

describe("reviewer round 2 repros (bounded work)", () => {
  afterEach(() => {
    for (const key of ["CSS", "Highlight", "NodeFilter", "document"]) Reflect.deleteProperty(globalThis, key);
  });

  it("reviewer round 2 repro: a preparation slice stops at its budget after every step, whatever the message sizes", () => {
    let clock = 0;
    let reads = 0;
    const blocks = Array.from(
      { length: 32 },
      (_, i) =>
        ({
          kind: "assistant",
          key: `big${i}`,
          streaming: false,
          get text() {
            reads++;
            return "plain text ".repeat(12_000);
          },
        }) as unknown as TranscriptBlockLike,
    ) as unknown as Parameters<typeof prepareSearch>[0];
    // Every clock read advances 10 ms, past the 8 ms budget: one step, then the slice ends.
    expect(prepareSearch(blocks, 8, () => (clock += 10))).toBe(false);
    // The old code processed 16 messages (32 reads) before looking at the clock.
    expect(reads).toBeLessThanOrEqual(2);
  });

  it("reviewer round 2 repro: one huge message is prepared across several budgeted slices", () => {
    let clock = 0;
    const blocks = toBlocks([said("huge", "word ".repeat(80_000))]);
    let slices = 1;
    while (!prepareSearch(blocks, 8, () => (clock += 10))) slices++;
    // 400,000 characters fold in bounded chunks, one per slice here.
    expect(slices).toBeGreaterThan(5);
  });

  it("reviewer round 2 repro: painting one visible message with 200,000 matches does bounded matching work", () => {
    const { registry, rect } = fakePage();
    const page = container(1, () => "a ".repeat(200_000), rect);
    const text = "a ".repeat(200_000);
    let calls = 0;
    const indexOf = String.prototype.indexOf;
    String.prototype.indexOf = function (this: string, ...args: Parameters<string["indexOf"]>) {
      calls++;
      return indexOf.apply(this, args);
    };
    try {
      // The current match as the search index locates it: element 0, last occurrence.
      const current = { key: "0", occurrence: 199_999, element: 0, start: text.length - 2, end: text.length - 1, paintFrom: text.length - 2 * 1000 - 2 };
      expect(showSearchMatches(page, "a", current, false)).toBe(true);
      // A scroll or stream repaint with no current match.
      expect(showSearchMatches(page, "a", null, false)).toBe(true);
    } finally {
      String.prototype.indexOf = indexOf;
    }
    expect(registry.get("conversation-search-current")).toBeUndefined();
    expect(calls).toBeLessThan(10_000);
  });
});

describe("reviewer round 2 repros (bounded work, rejected candidates)", () => {
  afterEach(() => {
    for (const key of ["CSS", "Highlight", "NodeFilter", "document"]) Reflect.deleteProperty(globalThis, key);
  });

  it("reviewer round 2 repro: a visible message full of near-misses (\"i\" inside \"İ\") does bounded matching work", () => {
    const { rect } = fakePage();
    const page = container(1, () => "İ".repeat(200_000), rect);
    let calls = 0;
    const indexOf = String.prototype.indexOf;
    String.prototype.indexOf = function (this: string, ...args: Parameters<string["indexOf"]>) {
      calls++;
      return indexOf.apply(this, args);
    };
    try {
      expect(showSearchMatches(page, "i", null, false)).toBe(true);
    } finally {
      String.prototype.indexOf = indexOf;
    }
    // No match at all (each candidate is half a character); looking is bounded anyway.
    expect(calls).toBeLessThan(10_000);
  });
});

describe("reviewer round 2 repros (jump to the match)", () => {
  const preparing = (needle: string): JumpState => ({ needle, ready: false, total: 0, located: false });
  const found = (needle: string): JumpState => ({ needle, ready: true, total: 3, located: true });

  it("reviewer round 2 repro: a query typed while indexing jumps when its results arrive, exactly once", () => {
    const jumps = new JumpTracker();
    jumps.request("api");
    // Typed during indexing: results are not there yet, nothing to scroll to.
    expect(jumps.take(preparing("api"))).toBeNull();
    // Results arrive and the match is located: scroll, once.
    const serial = jumps.take(found("api"));
    expect(serial).not.toBeNull();
    jumps.done(serial!);
    // Streamed output and scroll repaints afterwards do not scroll again.
    expect(jumps.take(found("api"))).toBeNull();
    expect(jumps.pending).toBe(false);
  });

  it("reviewer round 2 repro: the jump waits for the newest query, not an older one's results, and survives a failed attempt", () => {
    const jumps = new JumpTracker();
    jumps.request("ap");
    jumps.request("api");
    // Results for the older query arrive first: no jump for them.
    expect(jumps.take(found("ap"))).toBeNull();
    // Results for "api" are counted but its match is not on the page yet.
    expect(jumps.take({ needle: "api", ready: true, total: 3, located: false })).toBeNull();
    // Located: the jump is taken, but the match's day is still opening (no done yet): try again.
    expect(jumps.take(found("api"))).not.toBeNull();
    const retry = jumps.take(found("api"));
    expect(retry).not.toBeNull();
    jumps.done(retry!);
    expect(jumps.take(found("api"))).toBeNull();
  });

  it("reviewer round 2 repro: a manual step meanwhile replaces the pending jump, and no result drops it", () => {
    const jumps = new JumpTracker();
    const typed = jumps.request("api");
    const stepped = jumps.request("api");
    // A late success of the older request does not cancel the step's jump.
    jumps.done(typed);
    expect(jumps.take(found("api"))).toBe(stepped);
    jumps.done(stepped);
    // A query with no match: the request is dropped, nothing to scroll to later.
    jumps.request("zzz");
    expect(jumps.take({ needle: "zzz", ready: true, total: 0, located: false })).toBeNull();
    expect(jumps.pending).toBe(false);
  });
});

describe("search index off the UI thread", () => {
  /** A fake worker: the index runs when `drain` runs its scheduled slices, one at a time. */
  const harness = (now: () => number = () => performance.now()) => {
    const queue: Array<() => void> = [];
    const answers: Array<FromIndex> = [];
    const index = new SearchIndex((m) => answers.push(m), (run) => void queue.push(run), now);
    const sent: Array<ToIndex> = [];
    const port: SearchPort = {
      onmessage: null,
      postMessage: (m) => {
        sent.push(m);
        index.receive(m);
      },
      terminate() {},
    };
    const client = new SearchClient(port, () => {});
    const drain = () => {
      let slices = 0;
      while (queue.length) {
        queue.shift()!();
        slices++;
      }
      return slices;
    };
    return { client, answers, sent, drain };
  };

  it("counts and locates in slices, and a streamed update sends only the message that changed", () => {
    let clock = 0;
    const { client, answers, sent, drain } = harness(() => (clock += 3));
    const items = Array.from({ length: 300 }, (_, i) => said(`m${i}`, `Answer ${i}: the **API** is up, see \`api.log\`.`));
    const blocks = toBlocks(items);
    client.sync(blocks);
    client.query(foldQuery("api"));
    // Each slice stops at its 8 ms budget (3 ms per clock read here): many slices.
    expect(drain()).toBeGreaterThan(10);
    const results = answers.filter((a) => a.type === "results").at(-1)!;
    expect(results).toMatchObject({ needle: "api", total: 600 });

    client.locate("api", "m299", 1);
    drain();
    const located = answers.at(-1) as Extract<FromIndex, { type: "located" }>;
    expect(located.place).toMatchObject({ element: 0 });
    const shown = markdownShownTextFor(items[299]!);
    expect(shown.slice(located.place!.start, located.place!.end)).toBe("api");

    // A token streams into the last message: one block crosses, no reorder.
    sent.length = 0;
    const updated = [...blocks.slice(0, -1), said("m299", "the API grew")] as typeof blocks;
    client.sync(updated);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "sync", upserts: [{ key: "m299" }] });
    expect((sent[0] as Extract<ToIndex, { type: "sync" }>).order).toBeUndefined();
    drain();
    expect(answers.filter((a) => a.type === "results").at(-1)).toMatchObject({ total: 599 });
    // Nothing changed: nothing is sent.
    sent.length = 0;
    client.sync(updated);
    expect(sent).toHaveLength(0);
  });

  it("locates a match in a system message's body and paints exactly the matches around the current one", () => {
    const system = { kind: "user", key: "s1", text: "[Apollo] api first\nbody api and api", author: "system", seq: 1 } as unknown as TranscriptItem;
    const [block] = toBlocks([system]);
    expect(locateMatch(block!, foldQuery("api"), 2)).toEqual({ element: 1, start: 13, end: 16, paintFrom: 5 });
    expect(locateMatch(block!, foldQuery("api"), 3)).toBeNull();

    const { registry, rect } = fakePage();
    const starts: Array<number> = [];
    const createRange = (globalThis as unknown as { document: { createRange: () => object } }).document.createRange;
    (globalThis as unknown as { document: { createRange: () => object } }).document.createRange = () => {
      const r = createRange() as { setStart: (n: unknown, o: number) => void };
      return { ...r, setStart: (_: unknown, offset: number) => starts.push(offset), setEnd() {} };
    };
    const text = "aa ".repeat(3000);
    const page = container(1, () => text, rect);
    // Occurrence 2,500 starts at 7,500; painting starts 1,000 matches before it.
    expect(showSearchMatches(page, "aa", { key: "0", occurrence: 2500, element: 0, start: 7500, end: 7502, paintFrom: 4500 }, false)).toBe(true);
    expect(registry.get("conversation-search-current")!.ranges).toHaveLength(1);
    // Painted: true occurrence starts only (multiples of 3), from 4,500 on.
    expect(starts.length).toBeGreaterThan(1000);
    expect(starts.every((s) => s % 3 === 0)).toBe(true);
    // A stale location (the page shows other text there) is not shown as current.
    expect(showSearchMatches(page, "aa", { key: "0", occurrence: 0, element: 0, start: 1, end: 3, paintFrom: 1 }, false)).toBe(false);
  });
});

describe("reviewer round 3 repros (every scroll goes through the jump rules)", () => {
  /** Frames and delayed callbacks that run only when the test says so. */
  const scheduler = () => {
    let next = 1;
    const frames = new Map<number, () => void>();
    const laters = new Map<number, () => void>();
    const take = (queue: Map<number, () => void>) => {
      const [id, run] = queue.entries().next().value ?? [];
      if (id === undefined) return false;
      queue.delete(id);
      run!();
      return true;
    };
    return {
      frames,
      laters,
      runFrame: () => take(frames),
      runLater: () => take(laters),
      scheduler: {
        frame: (run: () => void) => (frames.set(next, run), next++),
        cancelFrame: (id: number) => void frames.delete(id),
        later: (run: () => void) => (laters.set(next, run), next++),
        cancelLater: (id: number) => void laters.delete(id),
      } satisfies PaintScheduler,
    };
  };
  /** The page: whether the match is on it yet; every scroll the painter made. */
  const page = () => {
    const state = { present: true, scrolls: 0 };
    const show = ((_c, _q, _m, scroll: boolean) => {
      if (state.present && scroll) state.scrolls++;
      return state.present;
    }) as typeof showSearchMatches;
    return { state, show };
  };
  const ready: JumpState = { needle: "api", ready: true, total: 3, located: true };
  const match = { key: "m", occurrence: 0, element: 0, start: 0, end: 3, paintFrom: 0 };
  const run = (jumps: JumpTracker, show: typeof showSearchMatches, s: PaintScheduler) =>
    paintAndJump({ container: {} as HTMLElement, query: "api", current: match, jumps, state: ready, onJump() {}, show, scheduler: s });

  it("reviewer round 3 repro: after a successful jump, the delayed settle does not pull the user back once they scrolled away", () => {
    const jumps = new JumpTracker();
    jumps.request("api");
    const { state, show } = page();
    const timers = scheduler();
    run(jumps, show, timers.scheduler);
    // The first frame finds the match and jumps to it.
    timers.runFrame();
    expect(state.scrolls).toBe(1);
    expect(jumps.pending).toBe(false);
    // The user scrolls away; then the delayed callback fires: no second scroll.
    while (timers.runLater() || timers.runFrame());
    expect(state.scrolls).toBe(1);
  });

  it("reviewer round 3 repro: a jump first made by the delayed settle is complete, so a later streamed update does not jump again", () => {
    const jumps = new JumpTracker();
    jumps.request("api");
    const { state, show } = page();
    const timers = scheduler();
    // The match's day is still opening: every frame attempt misses.
    state.present = false;
    const cleanup = run(jumps, show, timers.scheduler);
    let attempts = 0;
    while (timers.runFrame()) attempts++;
    expect(attempts).toBe(21);
    expect(state.scrolls).toBe(0);
    // Mounted by the time the delayed callback fires: it makes the jump, and that completes it.
    state.present = true;
    timers.runLater();
    expect(state.scrolls).toBe(1);
    expect(jumps.pending).toBe(false);
    cleanup();
    // A token streams in: the effect runs again and only repaints.
    const again = scheduler();
    run(jumps, show, again.scheduler);
    while (again.runFrame() || again.runLater());
    expect(state.scrolls).toBe(1);
  });

  it("a match that appears while its day is still opening is jumped to once, after the opening settled", () => {
    const jumps = new JumpTracker();
    jumps.request("api");
    const { state, show } = page();
    const timers = scheduler();
    state.present = false;
    run(jumps, show, timers.scheduler);
    timers.runFrame();
    // Mounted on the next frame, still animating: painted, not scrolled to yet.
    state.present = true;
    while (timers.runFrame());
    expect(state.scrolls).toBe(0);
    timers.runLater();
    expect(state.scrolls).toBe(1);
    expect(jumps.pending).toBe(false);
  });

  it("a jump that is still pending when a newer action replaces it does not scroll from the old run", () => {
    const jumps = new JumpTracker();
    jumps.request("api");
    const { state, show } = page();
    const timers = scheduler();
    state.present = false;
    run(jumps, show, timers.scheduler);
    while (timers.runFrame());
    // A step (newer request) arrives before the old run's delayed callback.
    jumps.request("api");
    state.present = true;
    timers.runLater();
    expect(state.scrolls).toBe(0);
    // The newer request's own run makes its jump, once.
    const next = scheduler();
    run(jumps, show, next.scheduler);
    while (next.runFrame() || next.runLater());
    expect(state.scrolls).toBe(1);
    expect(jumps.pending).toBe(false);
  });
});
