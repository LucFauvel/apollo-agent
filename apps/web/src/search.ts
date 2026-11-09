/**
 * Search inside a conversation, over the transcript the client already holds (it replays a
 * session's whole log), so folded days and collapsed messages are searched too. What is
 * searched is exactly what each message renders in its `data-search-text` elements, so the
 * count, the highlights and the jumps agree.
 */
import { countIn, foldText, type FoldedText, type SearchResults, systemMessageParts, toResults, type TranscriptBlock } from "@apollo/client";
import { markdownShownText } from "./components/Code.tsx";

/**
 * The text of each element a block marks with `data-search-text`, in page order (as
 * SessionView, SystemMessage and PeerMessage render them); null when search skips the block
 * (tool activity, cards, a silent run). Matches never span two elements.
 */
export const searchTexts = (block: TranscriptBlock): ReadonlyArray<string> | null => {
  switch (block.kind) {
    case "user":
      if (block.author === "user") return [block.text];
      if (block.author === "peer") return [markdownShownText(block.text)];
      {
        const { first, body } = systemMessageParts(block.text);
        return body ? [first, markdownShownText(body)] : [first];
      }
    case "assistant":
      return !block.streaming && block.text.trim() === "[SILENT]" ? null : [markdownShownText(block.text)];
    case "notice":
      return [block.message];
    default:
      return null;
  }
};

// Messages keep their object while unchanged (only a streaming one is replaced per update),
// so rendering and folding happen once per message, and counting once per message and query.
const prepared = new WeakMap<TranscriptBlock, ReadonlyArray<FoldedText> | null>();
const counted = new WeakMap<TranscriptBlock, { readonly needle: string; readonly count: number }>();

const foldedTexts = (block: TranscriptBlock) => {
  if (!prepared.has(block)) prepared.set(block, searchTexts(block)?.map(foldText) ?? null);
  return prepared.get(block)!;
};

/**
 * Prepares (renders and folds) messages not searched before, for up to `budgetMs`, so a
 * long conversation is indexed a slice at a time instead of in one long frame. True once
 * every message is ready.
 */
export const prepareSearch = (blocks: ReadonlyArray<TranscriptBlock>, budgetMs: number, now: () => number = () => performance.now()): boolean => {
  const deadline = now() + budgetMs;
  let checked = 0;
  for (const block of blocks) {
    if (!searchable(block) || prepared.has(block)) continue;
    foldedTexts(block);
    // Reading the clock is not free: look every few messages.
    if (++checked % 16 === 0 && now() > deadline) return false;
  }
  return true;
};

const blockCount = (block: TranscriptBlock, needle: string) => {
  const cached = counted.get(block);
  if (cached?.needle === needle) return cached.count;
  let count = 0;
  for (const text of foldedTexts(block) ?? []) count += countIn(text, needle);
  counted.set(block, { needle, count });
  return count;
};

const searchable = (block: TranscriptBlock) => block.kind === "user" || block.kind === "assistant" || block.kind === "notice";

/** Every match of a folded query (`foldQuery`) in a conversation, in order. */
export const conversationMatches = (blocks: ReadonlyArray<TranscriptBlock>, needle: string): SearchResults =>
  toResults(
    (function* () {
      if (!needle) return;
      for (const block of blocks) if (searchable(block)) yield [block.key, blockCount(block, needle)] as const;
    })(),
  );
