import type { ReplyRef } from "@apollo/contracts";
import type { TranscriptBlock } from "./activity.ts";

/** One line of a quoted message, for the reply chip and the quote above a reply. */
export const quoteLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Where the message a reply quotes is among the blocks (-1: not there, e.g. before a `/clear`). */
export const replyTargetIndex = (blocks: ReadonlyArray<TranscriptBlock>, replyTo: Pick<ReplyRef, "seq">) =>
  blocks.findIndex((b) => (b.kind === "user" || b.kind === "assistant") && b.seq === replyTo.seq);
