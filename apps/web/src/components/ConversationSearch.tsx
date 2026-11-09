import { findInSegments, type SearchMatch } from "@apollo/client";
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

const textNodes = (root: Element) => {
  const nodes: Array<Text> = [];
  // Controls inside rendered text (a code block's language and copy button) are not content.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest("[data-search-skip]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
};

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

/**
 * Highlights the current match and the others on or near the screen, and scrolls the
 * current one into view. The work is bounded: elements more than a screen away are
 * skipped (their highlights come with the next call, on scroll), at most PAINT_LIMIT
 * ranges are built, and no call takes all of them as arguments. Returns false while the
 * current match is not on the page yet (its day or message is still opening).
 */
export const showSearchMatches = (container: HTMLElement, query: string, current: SearchMatch | null, scroll: boolean): boolean => {
  const box = container.getBoundingClientRect();
  const margin = box.height;
  const all: Array<Range> = [];
  let currentRange: Range | null = null;
  let currentElement: HTMLElement | null = null;
  // Matches in earlier elements of the current match's message.
  let before = 0;
  for (const element of container.querySelectorAll<HTMLElement>(`[${SEARCH_TEXT_ATTR}]`)) {
    const isCurrent = current !== null && element.getAttribute(SEARCH_TEXT_ATTR) === current.key;
    if (!isCurrent) {
      if (all.length >= PAINT_LIMIT) continue;
      const rect = element.getBoundingClientRect();
      if (rect.bottom < box.top - margin || rect.top > box.bottom + margin) continue;
    }
    const nodes = textNodes(element);
    const points = findInSegments(
      nodes.map((n) => n.data),
      query,
    );
    const range = (i: number) => {
      const { start, end } = points[i]!;
      const r = document.createRange();
      r.setStart(nodes[start.segment]!, start.offset);
      r.setEnd(nodes[end.segment]!, end.offset);
      return r;
    };
    let from = 0;
    if (isCurrent) {
      currentElement ??= element;
      const wanted = current.occurrence - before;
      before += points.length;
      if (wanted >= 0 && wanted < points.length) {
        currentRange = range(wanted);
        // Paint the matches around the current one.
        from = Math.max(0, wanted - Math.floor((PAINT_LIMIT - all.length) / 2));
      }
    }
    for (let i = from; i < points.length && all.length < PAINT_LIMIT; i++) all.push(range(i));
  }
  const registry = highlights();
  if (registry) {
    const painted = new Highlight();
    for (const r of all) painted.add(r);
    registry.set(ALL, painted);
    if (currentRange) registry.set(CURRENT, new Highlight(currentRange));
    else registry.delete(CURRENT);
  }
  if (current && !currentRange) return false;
  if (scroll && currentElement) {
    const target = currentRange?.getBoundingClientRect() ?? currentElement.getBoundingClientRect();
    if (target.top < box.top + 48 || target.bottom > box.bottom - 24) {
      container.scrollTo({ top: container.scrollTop + target.top - box.top - container.clientHeight / 2 + target.height / 2 });
    }
  }
  return true;
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
