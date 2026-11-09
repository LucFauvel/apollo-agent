import { findInSegments, foldQuery, toBlocks, type TranscriptItem } from "@apollo/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownText } from "./components/Code.tsx";
import { opensSearch, showSearchMatches, type ShortcutEvent } from "./components/ConversationSearch.tsx";
import { conversationMatches, prepareSearch } from "./search.ts";

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

describe("reviewer round 1 repros (highlighting at scale)", () => {
  afterEach(() => {
    for (const key of ["CSS", "Highlight", "NodeFilter", "document"]) Reflect.deleteProperty(globalThis, key);
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

  it("reviewer round 1 repro: 5,000 mounted messages × 30 matches neither throw nor build every range", () => {
    const { registry, rect } = fakePage();
    const page = container(5000, () => "a ".repeat(30), rect);
    expect(() => showSearchMatches(page, "a", { key: "4999", occurrence: 29 }, true)).not.toThrow();
    // The current match is always highlighted; the rest only around what is on screen.
    expect(registry.get("conversation-search-current")?.ranges).toHaveLength(1);
    expect(rangesBuilt).toBeLessThan(5000);
  });

  it("reviewer round 1 repro: one visible message with 100,000 matches paints a bounded number of them", () => {
    const { registry, rect } = fakePage();
    const page = container(1, () => "a ".repeat(100_000), rect);
    expect(() => showSearchMatches(page, "a", { key: "0", occurrence: 99_999 }, false)).not.toThrow();
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
  });

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
