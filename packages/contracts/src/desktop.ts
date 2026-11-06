import * as Schema from "effect/Schema";
import { ServerStatus } from "./local.ts";

/** What the desktop app's menu bar / tray shows. Served to the desktop shell only. */
export const DesktopStatus = Schema.Struct({
  bots: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      paused: Schema.Boolean,
      /** Sessions starting or running a turn. */
      working: Schema.Number,
      /** Sessions waiting for the user's approval. */
      needsYou: Schema.Number,
    }),
  ),
  /** `null` when llama.cpp is not installed. */
  localModels: Schema.NullOr(
    Schema.Struct({
      server: ServerStatus,
      /** Models currently in memory. */
      loaded: Schema.Array(Schema.String),
      /** Models being loaded into memory, with progress 0-100. */
      loading: Schema.Array(Schema.Struct({ model: Schema.String, percent: Schema.Number })),
      downloads: Schema.Array(Schema.Struct({ model: Schema.String, percent: Schema.Number })),
    }),
  ),
});
export type DesktopStatus = typeof DesktopStatus.Type;
