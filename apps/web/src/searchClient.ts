/**
 * The UI side of conversation search: keeps the index (in a Web Worker) up to date and
 * asks it questions. Per update the UI thread only compares block identities and sends
 * the blocks that changed (one, while a message streams); the index does all the text work.
 */
import type { SearchResults, TranscriptBlock } from "@apollo/client";
import { useEffect, useRef, useState } from "react";
import { type FromIndex, isSearchable, SearchIndex, slimBlock, type ToIndex } from "./searchIndex.ts";
import type { MatchPlace } from "./search.ts";

/** Where messages to the index go and its answers come from (a Worker, or a stand-in). */
export interface SearchPort {
  postMessage(message: ToIndex): void;
  onmessage: ((event: { data: FromIndex }) => void) | null;
  terminate(): void;
}

/** The index in a Worker; on the UI thread (still in slices) where Workers are missing. */
export const createSearchPort = (): SearchPort => {
  if (typeof Worker !== "undefined") {
    return new Worker(new URL("./searchWorker.ts", import.meta.url), { type: "module" }) as unknown as SearchPort;
  }
  const port: SearchPort = {
    onmessage: null,
    postMessage: (message) => index.receive(message),
    terminate: () => {},
  };
  const index = new SearchIndex((data) => setTimeout(() => port.onmessage?.({ data }), 0));
  return port;
};

export class SearchClient {
  readonly #port: SearchPort;
  #sent = new Map<string, TranscriptBlock>();
  #order: ReadonlyArray<string> = [];

  constructor(port: SearchPort, onAnswer: (answer: FromIndex) => void) {
    this.#port = port;
    port.onmessage = (event) => onAnswer(event.data);
  }

  /** Sends what changed since the last sync: changed blocks, and the order if it changed. */
  sync(blocks: ReadonlyArray<TranscriptBlock>) {
    const upserts: Array<TranscriptBlock> = [];
    const order: Array<string> = [];
    for (const block of blocks) {
      if (!isSearchable(block)) continue;
      order.push(block.key);
      if (this.#sent.get(block.key) !== block) {
        this.#sent.set(block.key, block);
        upserts.push(slimBlock(block));
      }
    }
    const reordered = order.length !== this.#order.length || order.some((key, i) => key !== this.#order[i]);
    if (reordered) {
      const keep = new Set(order);
      for (const key of this.#sent.keys()) if (!keep.has(key)) this.#sent.delete(key);
      this.#order = order;
    }
    if (upserts.length === 0 && !reordered) return;
    this.#port.postMessage(reordered ? { type: "sync", order, upserts } : { type: "sync", upserts });
  }

  query(needle: string) {
    this.#port.postMessage({ type: "query", needle });
  }

  locate(needle: string, key: string, occurrence: number) {
    this.#port.postMessage({ type: "locate", needle, key, occurrence });
  }

  close() {
    this.#port.onmessage = null;
    this.#port.terminate();
  }
}

/** Results the index counted for `needle`. */
export interface CountedResults {
  readonly needle: string;
  readonly results: SearchResults;
}

/** A match located in its message, for the query it was located for. */
export type LocatedMatch = { readonly needle: string; readonly key: string; readonly occurrence: number } & MatchPlace;

/**
 * Search over a conversation while `open`: the latest counted results (null until the
 * first arrive) and the located current match. `locate` asks for a match's place.
 */
export const useConversationSearch = (blocks: ReadonlyArray<TranscriptBlock>, open: boolean, needle: string) => {
  const client = useRef<SearchClient | null>(null);
  const [counted, setCounted] = useState<CountedResults | null>(null);
  const [located, setLocated] = useState<LocatedMatch | null>(null);
  useEffect(() => {
    if (!open) return;
    const search = new SearchClient(createSearchPort(), (answer) => {
      if (answer.type === "results") setCounted({ needle: answer.needle, results: { total: answer.total, keys: answer.keys, ends: answer.ends } });
      else if (answer.place) setLocated({ needle: answer.needle, key: answer.key, occurrence: answer.occurrence, ...answer.place });
      else setLocated(null);
    });
    client.current = search;
    return () => {
      search.close();
      client.current = null;
      setCounted(null);
      setLocated(null);
    };
  }, [open]);
  useEffect(() => client.current?.sync(blocks), [open, blocks]);
  useEffect(() => client.current?.query(needle), [open, needle]);
  return { counted, located, locate: (key: string, occurrence: number) => client.current?.locate(needle, key, occurrence) };
};
