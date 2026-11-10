/**
 * The conversation's search index. It runs in a Web Worker (searchWorker.ts), so rendering
 * messages to text, folding and counting never run on the UI thread; there too it works in
 * budgeted slices and yields between them, so newer queries and updates are taken in
 * between. The UI thread only sends what changed (SearchClient) and paints.
 */
import type { SearchResults, TranscriptBlock } from "@apollo/client";
import { conversationMatches, locateMatch, type MatchPlace, prepareSearch } from "./search.ts";

/** What the UI sends. Blocks are the searchable fields only (see `slimBlock`). */
export type ToIndex =
  | {
      readonly type: "sync";
      /** The searchable blocks' keys, in order, when they changed (added or removed). */
      readonly order?: ReadonlyArray<string>;
      /** Blocks new or changed since the last sync. */
      readonly upserts: ReadonlyArray<TranscriptBlock>;
    }
  | { readonly type: "query"; readonly needle: string }
  | { readonly type: "locate"; readonly needle: string; readonly key: string; readonly occurrence: number };

/** What the index answers. */
export type FromIndex =
  | ({ readonly type: "results"; readonly needle: string } & SearchResults)
  | { readonly type: "located"; readonly needle: string; readonly key: string; readonly occurrence: number; readonly place: MatchPlace | null };

/** The fields search reads from a block: all that is sent to the index. */
export const slimBlock = (block: TranscriptBlock): TranscriptBlock => {
  switch (block.kind) {
    case "user":
      return { kind: "user", key: block.key, text: block.text, author: block.author, seq: block.seq } as TranscriptBlock;
    case "assistant":
      return { kind: "assistant", key: block.key, text: block.text, streaming: block.streaming } as TranscriptBlock;
    case "notice":
      return { kind: "notice", key: block.key, level: block.level, message: block.message } as TranscriptBlock;
    default:
      return block;
  }
};

export const isSearchable = (block: TranscriptBlock) => block.kind === "user" || block.kind === "assistant" || block.kind === "notice";

/** Work per slice before yielding. */
export const SLICE_MS = 8;

export class SearchIndex {
  #order: Array<string> = [];
  readonly #blocks = new Map<string, TranscriptBlock>();
  #list: Array<TranscriptBlock> = [];
  #needle = "";
  /** Results to send: the query or the conversation changed. */
  #stale = false;
  #locate: Extract<ToIndex, { type: "locate" }> | null = null;
  #scheduled = false;

  readonly #post: (message: FromIndex) => void;
  readonly #schedule: (run: () => void) => void;
  readonly #now: () => number;

  constructor(
    post: (message: FromIndex) => void,
    schedule: (run: () => void) => void = (run) => void setTimeout(run, 0),
    now: () => number = () => performance.now(),
  ) {
    this.#post = post;
    this.#schedule = schedule;
    this.#now = now;
  }

  receive(message: ToIndex) {
    switch (message.type) {
      case "sync": {
        for (const block of message.upserts) this.#blocks.set(block.key, block);
        if (message.order) {
          this.#order = [...message.order];
          const keep = new Set(this.#order);
          for (const key of this.#blocks.keys()) if (!keep.has(key)) this.#blocks.delete(key);
        }
        this.#list = this.#order.flatMap((key) => this.#blocks.get(key) ?? []);
        this.#stale = true;
        break;
      }
      case "query":
        this.#needle = message.needle;
        this.#stale = true;
        break;
      case "locate":
        this.#locate = message;
        break;
    }
    this.#kick();
  }

  #kick() {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedule(() => {
      this.#scheduled = false;
      this.#work();
    });
  }

  /** One slice: prepare what is new; once everything is, answer. */
  #work() {
    if (!prepareSearch(this.#list, SLICE_MS, this.#now)) return this.#kick();
    if (this.#stale) {
      this.#stale = false;
      this.#post({ type: "results", needle: this.#needle, ...conversationMatches(this.#list, this.#needle) });
    }
    const locate = this.#locate;
    if (locate) {
      this.#locate = null;
      const block = this.#blocks.get(locate.key);
      this.#post({ ...locate, type: "located", place: block ? locateMatch(block, locate.needle, locate.occurrence) : null });
    }
  }
}
