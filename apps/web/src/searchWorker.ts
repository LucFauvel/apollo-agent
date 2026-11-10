/** The conversation search index, off the UI thread (see searchIndex.ts). */
import { type FromIndex, SearchIndex, type ToIndex } from "./searchIndex.ts";

const scope = globalThis as unknown as { postMessage: (message: FromIndex) => void };
const index = new SearchIndex((message) => scope.postMessage(message));
addEventListener("message", (event) => index.receive((event as MessageEvent<ToIndex>).data));
