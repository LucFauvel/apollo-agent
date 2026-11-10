/**
 * Search inside a conversation, over the transcript the client already holds (it replays a
 * session's whole log), so folded days and collapsed messages are searched too. What is
 * searched is exactly what each message renders in its `data-search-text` elements, so the
 * count, the highlights and the jumps agree.
 */
import { countIn, foldInSteps, type FoldedText, occurrencesIn, type SearchResults, systemMessageParts, toResults, type TranscriptBlock } from "@apollo/client";
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

/** Characters folded per preparation step. */
export const FOLD_CHUNK = 16_384;

interface Progress {
  readonly texts: ReadonlyArray<string>;
  readonly folded: Array<FoldedText>;
  fold: ReturnType<typeof foldInSteps> | null;
}
const inProgress = new WeakMap<TranscriptBlock, Progress>();

const searchable = (block: TranscriptBlock) => block.kind === "user" || block.kind === "assistant" || block.kind === "notice";

/**
 * One bounded step of preparing a message: render its text (one step per message), or
 * fold FOLD_CHUNK more characters of it. Long messages take many steps.
 */
const prepareStep = (block: TranscriptBlock) => {
  let progress = inProgress.get(block);
  if (!progress) {
    const texts = searchTexts(block);
    if (texts === null || texts.length === 0) prepared.set(block, texts === null ? null : []);
    else inProgress.set(block, { texts, folded: [], fold: null });
    return;
  }
  progress.fold ??= foldInSteps(progress.texts[progress.folded.length]!);
  const done = progress.fold.step(FOLD_CHUNK);
  if (!done) return;
  progress.folded.push(done);
  progress.fold = null;
  if (progress.folded.length === progress.texts.length) {
    prepared.set(block, progress.folded);
    inProgress.delete(block);
  }
};

const foldedTexts = (block: TranscriptBlock) => {
  while (!prepared.has(block)) prepareStep(block);
  return prepared.get(block)!;
};

/**
 * Prepares (renders and folds) messages not searched before, one bounded step at a time,
 * and stops as soon as `budgetMs` is spent: the clock is read after every step, so a slice
 * overruns by at most one step (one message's rendering, or one fold chunk). True once
 * every message is ready.
 */
export const prepareSearch = (blocks: ReadonlyArray<TranscriptBlock>, budgetMs: number, now: () => number = () => performance.now()): boolean => {
  const deadline = now() + budgetMs;
  for (const block of blocks) {
    if (!searchable(block)) continue;
    while (!prepared.has(block)) {
      prepareStep(block);
      if (now() >= deadline) return false;
    }
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

/** Every match of a folded query (`foldQuery`) in a conversation, in order. */
export const conversationMatches = (blocks: ReadonlyArray<TranscriptBlock>, needle: string): SearchResults =>
  toResults(
    (function* () {
      if (!needle) return;
      for (const block of blocks) if (searchable(block)) yield [block.key, blockCount(block, needle)] as const;
    })(),
  );

/** Matches painted around the current one, on each side. */
export const PAINT_AROUND = 1000;

/** Where a match is in its message: which `data-search-text` element, and its offsets there. */
export interface MatchPlace {
  readonly element: number;
  readonly start: number;
  readonly end: number;
  /** Where to start painting the matches around it (an earlier match's start, same element). */
  readonly paintFrom: number;
}

/** Locates the `occurrence`-th match of a folded query in a message. */
export const locateMatch = (block: TranscriptBlock, needle: string, occurrence: number): MatchPlace | null => {
  if (!needle || occurrence < 0) return null;
  const texts = foldedTexts(block) ?? [];
  let rest = occurrence;
  for (let element = 0; element < texts.length; element++) {
    const count = countIn(texts[element]!, needle);
    if (rest < count) {
      const found = occurrencesIn(texts[element]!, needle, rest + 1);
      const [start, end] = found[rest]!;
      return { element, start, end, paintFrom: found[Math.max(0, rest - PAINT_AROUND)]![0] };
    }
    rest -= count;
  }
  return null;
};
