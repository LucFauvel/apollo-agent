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

/** Ranges of `query` in one rendered element's text. */
const rangesIn = (element: Element, query: string) => {
  const nodes = textNodes(element);
  return findInSegments(
    nodes.map((n) => n.data),
    query,
  ).map(({ start, end }) => {
    const range = document.createRange();
    range.setStart(nodes[start.segment]!, start.offset);
    range.setEnd(nodes[end.segment]!, end.offset);
    return range;
  });
};

export const clearSearchHighlights = () => {
  highlights()?.delete(ALL);
  highlights()?.delete(CURRENT);
};

/**
 * Highlights every rendered match and the current one, and scrolls the current one into
 * view. Returns false while the current match's message is not on the page yet (its day
 * or message is still opening).
 */
export const showSearchMatches = (container: HTMLElement, query: string, current: SearchMatch | null, scroll: boolean): boolean => {
  const all: Array<Range> = [];
  let currentRange: Range | null = null;
  let currentElement: HTMLElement | null = null;
  const seen = new Map<string, number>();
  for (const element of container.querySelectorAll<HTMLElement>(`[${SEARCH_TEXT_ATTR}]`)) {
    const key = element.getAttribute(SEARCH_TEXT_ATTR)!;
    const ranges = rangesIn(element, query);
    all.push(...ranges);
    if (current && key === current.key) {
      currentElement ??= element;
      const before = seen.get(key) ?? 0;
      const wanted = current.occurrence - before;
      if (wanted >= 0 && wanted < ranges.length) currentRange = ranges[wanted]!;
      // Rendered text can differ slightly from what was counted: fall back to the message's last match.
      else if (ranges.length > 0 && !currentRange) currentRange = ranges.at(-1)!;
    }
    seen.set(key, (seen.get(key) ?? 0) + ranges.length);
  }
  const registry = highlights();
  if (registry) {
    registry.set(ALL, new Highlight(...all));
    if (currentRange) registry.set(CURRENT, new Highlight(currentRange));
    else registry.delete(CURRENT);
  }
  if (current && !currentElement) return false;
  if (scroll && currentElement) {
    const target = currentRange?.getBoundingClientRect() ?? currentElement.getBoundingClientRect();
    const box = container.getBoundingClientRect();
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
  inputRef,
  onQuery,
  onStep,
  onClose,
}: {
  query: string;
  index: number;
  count: number;
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
      <span className={cx("min-w-12 shrink-0 text-right text-[11px] tabular-nums", searching && count === 0 ? "text-red-300/80" : "text-zinc-500")} aria-live="polite">
        {searching ? (count === 0 ? "No results" : `${index + 1} of ${count}`) : ""}
      </span>
      <span className="mx-0.5 h-4 w-px bg-zinc-800" />
      <IconButton icon={ChevronUp} label="Previous match (Shift+Enter)" size="sm" disabled={count === 0} onClick={() => onStep(-1)} />
      <IconButton icon={ChevronDown} label="Next match (Enter)" size="sm" disabled={count === 0} onClick={() => onStep(1)} />
      <IconButton icon={X} label="Close (Esc)" size="sm" onClick={onClose} />
    </div>
  );
}
