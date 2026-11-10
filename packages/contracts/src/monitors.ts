import * as Schema from "effect/Schema";
import { BotId, SessionId, Timestamp } from "./domain.ts";

/**
 * A command an agent watches: each line it prints on stdout is delivered to the agent's
 * session as a message, until the command exits, its time is up, or the agent or the user
 * stops it (the user from the session's monitor strip).
 */
export const Monitor = Schema.Struct({
  id: Schema.String,
  botId: BotId,
  sessionId: SessionId,
  /** What the agent said it watches for, shown to the user. */
  description: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  status: Schema.Literals(["running", "exited", "stopped", "timed_out"]),
  /** Who stopped it, when `status` is `stopped`. */
  stoppedBy: Schema.NullOr(Schema.Literals(["agent", "user"])),
  startedAt: Timestamp,
  endedAt: Schema.NullOr(Timestamp),
  /** When it stops on its own; null: only when the command exits or someone stops it. */
  deadline: Schema.NullOr(Timestamp),
  /** Lines delivered to the agent so far. */
  events: Schema.Number,
  lastEvent: Schema.NullOr(Schema.String),
  lastEventAt: Schema.NullOr(Timestamp),
  exitCode: Schema.NullOr(Schema.Number),
});
export type Monitor = typeof Monitor.Type;
