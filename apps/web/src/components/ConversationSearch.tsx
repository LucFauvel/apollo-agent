import { foldQuery, foldText, occurrencesIn, type SearchMatch } from "@apollo/client";
import type { MatchPlace } from "../search.ts";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { type RefObject, useEffect } from "react";
import { cx, IconButton } from "./ui.tsx";

/**
 * Rendered message text is marked with `data-search-text={block key}`; search highlights
 * matches there with the CSS Custom Highlight API, so React's DOM is never touched.
 */
export const SEARCH_TEXT_ATTR = "data-search-text";

const ALL = "conversation-search";
const CURRENT = "conversation-search-current";

const highlights = () => (typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null);


/** The keys of an event, and where it happened. */
export interface ShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
}

/** An open modal dialog (see Modal in ui.tsx). */
const MODAL = '[aria-modal="true"]';

/**
 * Whether a key press opens conversation search (Cmd/Ctrl+F). Never while a dialog is
 * open or for a press inside one: the dialog keeps the keys and the focus. Nor when
 * something else already handled the press.
 */
export const opensSearch = (e: ShortcutEvent, root: ParentNode): boolean => {
  if (e.defaultPrevented) return false;
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return false;
  if (root.querySelector(MODAL)) return false;
  const target = e.target as Partial<Element> | null;
  if (typeof target?.closest === "function" && target.closest(`[role="dialog"], ${MODAL}`)) return false;
  return true;
};

export const clearSearchHighlights = () => {
  highlights()?.delete(ALL);
  highlights()?.delete(CURRENT);
};

/** At most this many matches are painted at once (the current one always is). */
export const PAINT_LIMIT = 2000;
/** Characters of one element's text matched per paint (around the current match, or from its start). */
export const PAINT_WINDOW = 20_000;
/** Candidate positions looked at per element and paint, matches or not. */
const PAINT_STEPS = 2 * PAINT_LIMIT;

/** The current match and where the index located it (element of its message, offsets there). */
export type CurrentMatch = SearchMatch & MatchPlace;

/** Text nodes of an element with their offsets: those ending after `from`, until one reaches `until`. */
const nodesBetween = (root: Element, from: number, until: number) => {
  // Controls inside rendered text (a code block's language and copy button) are not content.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest("[data-search-skip]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Array<{ readonly node: Text; readonly start: number }> = [];
  let pos = 0;
  for (let node = walker.nextNode() as Text | null; node && pos < until; node = walker.nextNode() as Text | null) {
    if (pos + node.data.length > from) nodes.push({ node, start: pos });
    pos += node.data.length;
  }
  return nodes;
};

/** A DOM range for [start, end) of an element's text, from its nodes (sorted by offset). */
const rangeFor = (nodes: ReadonlyArray<{ readonly node: Text; readonly start: number }>, start: number, end: number, hint = { i: 0 }) => {
  while (hint.i < nodes.length - 1 && start >= nodes[hint.i]!.start + nodes[hint.i]!.node.data.length) hint.i++;
  let j = hint.i;
  while (j < nodes.length - 1 && end > nodes[j]!.start + nodes[j]!.node.data.length) j++;
  const range = document.createRange();
  range.setStart(nodes[hint.i]!.node, start - nodes[hint.i]!.start);
  range.setEnd(nodes[j]!.node, end - nodes[j]!.start);
  return range;
};

/** Text of the nodes from offset `from`, at most `length` characters. */
const windowText = (nodes: ReadonlyArray<{ readonly node: Text; readonly start: number }>, from: number, length: number) => {
  let text = "";
  for (const { node, start } of nodes) {
    text += node.data.slice(Math.max(0, from - start), Math.max(0, from + length - start));
    if (text.length >= length) break;
  }
  return text.slice(0, length);
};

/** Ranges of the matches in an element's text from `from` (a match start, or 0), bounded in characters, steps and count. */
const paintIn = (element: Element, needle: string, from: number, limit: number): Array<Range> => {
  if (limit <= 0) return [];
  const nodes = nodesBetween(element, from, from + PAINT_WINDOW);
  const found = occurrencesIn(foldText(windowText(nodes, from, PAINT_WINDOW)), needle, limit, PAINT_STEPS);
  const hint = { i: 0 };
  return found.map(([start, end]) => rangeFor(nodes, from + start, from + end, hint));
};

/** The current match's range, if the page shows the text the index located it in. */
const currentRangeIn = (element: Element, needle: string, current: CurrentMatch) => {
  const nodes = nodesBetween(element, current.start, current.end);
  if (nodes.length === 0) return null;
  if (foldText(windowText(nodes, current.start, current.end - current.start)).folded !== needle) return null;
  return rangeFor(nodes, current.start, current.end);
};

/** The first element whose bottom is at or below `top` (elements are in page order). */
const firstBelow = (elements: ArrayLike<HTMLElement>, top: number) => {
  let lo = 0;
  let hi = elements.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (elements[mid]!.getBoundingClientRect().bottom < top) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * Highlights the current match and the others on or near the screen, and scrolls the
 * current one into view. Bounded work whatever the conversation or a message's size: the
 * on-screen elements are found by binary search, each is matched over at most PAINT_WINDOW
 * characters and PAINT_STEPS candidates, at most PAINT_LIMIT ranges are built, and the
 * current match comes located from the index (no scan up to it). Returns false while the
 * current match is not on the page yet (its day or message is still opening, or the page
 * is a render behind the index).
 */
export const showSearchMatches = (container: HTMLElement, query: string, current: CurrentMatch | null, scroll: boolean): boolean => {
  const needle = foldQuery(query);
  const box = container.getBoundingClientRect();
  const margin = box.height;
  const elements = container.querySelectorAll<HTMLElement>(`[${SEARCH_TEXT_ATTR}]`);
  const all: Array<Range> = [];
  let currentRange: Range | null = null;
  let currentElement: HTMLElement | null = null;
  if (current && needle) {
    let seen = 0;
    for (let i = 0; i < elements.length && !currentElement; i++) {
      if (elements[i]!.getAttribute(SEARCH_TEXT_ATTR) !== current.key) continue;
      if (seen++ === current.element) currentElement = elements[i]!;
    }
    if (currentElement) {
      currentRange = currentRangeIn(currentElement, needle, current);
      if (currentRange) for (const range of paintIn(currentElement, needle, current.paintFrom, PAINT_LIMIT / 2)) all.push(range);
    }
  }
  if (needle) {
    for (let i = firstBelow(elements, box.top - margin); i < elements.length && all.length < PAINT_LIMIT; i++) {
      const element = elements[i]!;
      if (element === currentElement) continue;
      if (element.getBoundingClientRect().top > box.bottom + margin) break;
      for (const range of paintIn(element, needle, 0, PAINT_LIMIT - all.length)) all.push(range);
    }
  }
  const registry = highlights();
  if (registry) {
    const painted = new Highlight();
    for (const range of all) painted.add(range);
    registry.set(ALL, painted);
    if (currentRange) registry.set(CURRENT, new Highlight(currentRange));
    else registry.delete(CURRENT);
  }
  if (current && !currentRange) return false;
  if (scroll && currentRange) {
    const target = currentRange.getBoundingClientRect();
    if (target.top < box.top + 48 || target.bottom > box.bottom - 24) {
      container.scrollTo({ top: container.scrollTop + target.top - box.top - container.clientHeight / 2 + target.height / 2 });
    }
  }
  return true;
};

/** Where search stands for the query it last counted. */
export interface JumpState {
  /** The folded query whose results are on hand. */
  readonly needle: string;
  /** Its results have arrived (not still preparing the conversation). */
  readonly ready: boolean;
  readonly total: number;
  /** The current match is located on the page for this query. */
  readonly located: boolean;
}

/**
 * The jump to the current match that a search action asks for (typing a query, stepping),
 * taken once: when its query's results are ready and the match can be shown. A newer
 * request replaces an older one.
 */
export class JumpTracker {
  #intent: { readonly needle: string; readonly serial: number } | null = null;
  #serial = 0;

  /** A search action for `needle` wants its match brought into view. */
  request(needle: string): number {
    this.#intent = { needle, serial: ++this.#serial };
    return this.#serial;
  }

  /**
   * The serial of the jump to make now, or null to wait (results or the match not there
   * yet) or because there is nothing to do. The request stays until `done(serial)` reports
   * the match shown, or its query turns out to have no match.
   */
  take(state: JumpState): number | null {
    const intent = this.#intent;
    if (!intent || state.needle !== intent.needle || !state.ready) return null;
    if (state.total === 0) {
      this.#intent = null;
      return null;
    }
    return state.located ? intent.serial : null;
  }

  /** The jump `serial` was made (a newer request since then stays). */
  done(serial: number) {
    if (this.#intent?.serial === serial) this.#intent = null;
  }

  /** Whether the jump `serial` is still to be made (not done, not replaced, not dropped). */
  holds(serial: number) {
    return this.#intent?.serial === serial;
  }

  get pending() {
    return this.#intent !== null;
  }
}

/** The timers `paintAndJump` uses (animation frames and a delay), replaceable in tests. */
export interface PaintScheduler {
  frame(run: () => void): number;
  cancelFrame(id: number): void;
  later(run: () => void, ms: number): number;
  cancelLater(id: number): void;
}

const browserScheduler: PaintScheduler = {
  frame: (run) => requestAnimationFrame(run),
  cancelFrame: (id) => cancelAnimationFrame(id),
  later: (run, ms) => setTimeout(run, ms) as unknown as number,
  cancelLater: (id) => clearTimeout(id),
};

/** How long opening a day or message animates its height. */
export const OPEN_SETTLE_MS = 320;

/**
 * Paints the matches and, when a search action's jump is due (JumpTracker), brings the
 * current match into view: once. Every path that scrolls checks that its jump is still
 * the one to make and reports it done when it succeeded, so nothing scrolls after the jump
 * was made, for a replaced request, or twice. If the match is on the page at the first
 * frame, the jump happens then; if its day or message is still opening, frames only paint
 * and the jump happens once the opening has settled. Returns a cleanup that cancels what
 * is still scheduled (a jump not made yet stays pending for the next run).
 */
export const paintAndJump = ({
  container,
  query,
  current,
  jumps,
  state,
  onJump,
  show = showSearchMatches,
  scheduler = browserScheduler,
}: {
  container: HTMLElement;
  query: string;
  current: CurrentMatch | null;
  jumps: JumpTracker;
  state: JumpState;
  /** Called when this run is going to move the view (the conversation stops sticking to the bottom). */
  onJump: () => void;
  show?: typeof showSearchMatches;
  scheduler?: PaintScheduler;
}): (() => void) => {
  const serial = jumps.take(state);
  if (serial !== null) onJump();
  const due = () => serial !== null && jumps.holds(serial);
  let tries = 0;
  let frame = 0;
  // The match's day or message may still be mounting: retry for a few frames (painting).
  const run = () => {
    // Only the first attempt jumps: a later one means the match is still opening and moving.
    const jump = tries === 0 && due();
    if (show(container, query, current, jump)) {
      if (jump) jumps.done(serial!);
    } else if (tries++ < 20) frame = scheduler.frame(run);
  };
  frame = scheduler.frame(run);
  // Opening a day or message animates its height: make a jump not made yet once it settled.
  const settle =
    serial !== null
      ? scheduler.later(() => {
          if (due() && show(container, query, current, true)) jumps.done(serial);
        }, OPEN_SETTLE_MS)
      : undefined;
  return () => {
    scheduler.cancelFrame(frame);
    if (settle !== undefined) scheduler.cancelLater(settle);
  };
};

/** The find bar over the conversation: query, match count, previous/next, close. */
export function ConversationSearchBar({
  query,
  index,
  count,
  pending,
  inputRef,
  onQuery,
  onStep,
  onClose,
}: {
  query: string;
  index: number;
  count: number;
  /** Still preparing the conversation or catching up with typing: no count yet. */
  pending: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onQuery: (query: string) => void;
  onStep: (step: 1 | -1) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [inputRef]);
  const searching = query.trim().length > 0;
  return (
    <div
      role="search"
      // Escape closes from the field and from the buttons alike.
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      className="animate-pop-in absolute top-2 right-4 z-20 flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/95 py-1 pr-1 pl-2.5 shadow-lg shadow-black/40 backdrop-blur"
    >
      <Search className="size-3.5 shrink-0 text-zinc-500" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            onStep(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1);
          }
        }}
        placeholder="Search in conversation"
        aria-label="Search in conversation"
        spellCheck={false}
        className="w-52 bg-transparent py-1 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
      />
      <span
        className={cx("min-w-12 shrink-0 text-right text-[11px] tabular-nums", searching && !pending && count === 0 ? "text-red-300/80" : "text-zinc-500")}
        aria-live="polite"
      >
        {!searching ? "" : pending && count === 0 ? "Searching…" : count === 0 ? "No results" : `${index + 1} of ${count}`}
      </span>
      <span className="mx-0.5 h-4 w-px bg-zinc-800" />
      <IconButton icon={ChevronUp} label="Previous match (Shift+Enter)" size="sm" disabled={count === 0} onClick={() => onStep(-1)} />
      <IconButton icon={ChevronDown} label="Next match (Enter)" size="sm" disabled={count === 0} onClick={() => onStep(1)} />
      <IconButton icon={X} label="Close (Esc)" size="sm" onClick={onClose} />
    </div>
  );
}
