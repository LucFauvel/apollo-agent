import * as Schema from "effect/Schema";
import { BotId, SessionId } from "./domain.ts";

/** A page in Apollo's built-in browser. Tabs belong to a bot; any of its sessions can use them. */
export const BrowserTab = Schema.Struct({
  id: Schema.String,
  botId: BotId,
  /** The session that opened the tab. */
  sessionId: SessionId,
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  openedAt: Schema.Number,
});
export type BrowserTab = typeof BrowserTab.Type;

/** Whether a Chromium-based browser was found on this machine. */
export const BrowserStatus = Schema.Struct({
  available: Schema.Boolean,
  /** The browser Apollo runs, when found. */
  executable: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type BrowserStatus = typeof BrowserStatus.Type;

/** One frame of a tab's live view (JPEG, base64). */
export const BrowserFrame = Schema.Struct({
  data: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});
export type BrowserFrame = typeof BrowserFrame.Type;

/** Input from the user's live view. Coordinates are fractions (0–1) of the frame. */
export const BrowserInput = Schema.Union([
  Schema.TaggedStruct("click", { x: Schema.Number, y: Schema.Number }),
  Schema.TaggedStruct("scroll", { x: Schema.Number, y: Schema.Number, deltaX: Schema.Number, deltaY: Schema.Number }),
  Schema.TaggedStruct("text", { text: Schema.String }),
  Schema.TaggedStruct("key", { key: Schema.String }),
  Schema.TaggedStruct("history", { direction: Schema.Literals(["back", "forward", "reload"]) }),
]);
export type BrowserInput = typeof BrowserInput.Type;
