import { ApolloError, Monitor } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES, Monitors } from "../monitors/Monitors.ts";
import { McpCaller } from "./Caller.ts";

/** Monitors: watch a command's output and get each line as a message, until stopped. */

const shared = {
  failure: ApolloError,
  failureMode: "return" as const,
  dependencies: [McpCaller],
};

const Start = Tool.make("apollo_monitor_start", {
  ...shared,
  description: [
    "Watch for events: start a monitor that runs `command` in the background and sends you each line it prints",
    "on stdout as a message (lines printed within a second arrive together), so you can react without polling.",
    "Write the command to print only what matters, one line per event, e.g. `tail -f app.log | grep --line-buffered ERROR`,",
    "or a loop that checks something every 30 s and prints when it changes (use `grep --line-buffered` in pipes).",
    "Stderr is not delivered. `description` tells the user what it watches; they see it and can stop it.",
    "It stops after `timeoutMinutes` (default 60, max 1440) unless `persistent` is true, or when the command exits",
    "(you are told how it ended), or when you call apollo_monitor_stop. Prefer apollo_job_run for a command you",
    "only need the result of.",
  ].join(" "),
  parameters: Schema.Struct({
    command: Schema.String,
    description: Schema.String.annotate({ description: "What it watches for, in a few words, shown to the user." }),
    cwd: Schema.optional(Schema.String),
    timeoutMinutes: Schema.optional(Schema.Number),
    persistent: Schema.optional(Schema.Boolean).annotate({
      description: "Run until the command exits or it is stopped, with no timeout.",
    }),
  }),
  success: Monitor,
});

const Stop = Tool.make("apollo_monitor_stop", {
  ...shared,
  description: "Stop one of your monitors and everything its command started.",
  parameters: Schema.Struct({ monitorId: Schema.String }),
  success: Monitor,
});

const List = Tool.make("apollo_monitor_list", {
  ...shared,
  description: "This session's monitors, running and recently ended.",
  success: Schema.Struct({ monitors: Schema.Array(Monitor) }),
}).annotate(Tool.Readonly, true);

export const MonitorToolkit = Toolkit.make(Start, Stop, List);

/** The time a monitor may run, in ms (null: no limit). */
export const timeoutMs = (timeoutMinutes: number | undefined, persistent: boolean | undefined) => {
  if (persistent) return null;
  const minutes = timeoutMinutes === undefined || !Number.isFinite(timeoutMinutes) ? DEFAULT_TIMEOUT_MINUTES : timeoutMinutes;
  return Math.round(Math.min(Math.max(minutes, 1), MAX_TIMEOUT_MINUTES) * 60_000);
};

export const handlers = MonitorToolkit.toLayer(
  Effect.gen(function* () {
    const monitors = yield* Monitors;
    return {
      apollo_monitor_start: ({ command, description, cwd, timeoutMinutes, persistent }) =>
        Effect.flatMap(McpCaller, (caller) =>
          monitors.start(caller, { command, description, cwd, timeoutMs: timeoutMs(timeoutMinutes, persistent) }),
        ),
      apollo_monitor_stop: ({ monitorId }) => Effect.flatMap(McpCaller, (caller) => monitors.stop(caller, monitorId)),
      apollo_monitor_list: () =>
        Effect.flatMap(McpCaller, (caller) => Effect.map(monitors.listFor(caller), (list) => ({ monitors: list }))),
    };
  }),
);
