import { ApolloError } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { SessionManager } from "../SessionManager.ts";
import { McpCaller } from "./Caller.ts";

/**
 * Explaining code changes. Apollo detects which files each turn changed and shows them as
 * a semantic diff (by function, class, type, section); the agent only adds the "why".
 */

const shared = {
  failure: ApolloError,
  failureMode: "return" as const,
  dependencies: [McpCaller],
};

const Explain = Tool.make("apollo_explain_changes", {
  ...shared,
  description: [
    "Explain the code changes you made in this turn, for the user's Changes panel and your orchestrator's report.",
    "Apollo already knows which files changed and shows each one grouped by the functions, classes and types it",
    "touches: do not list changes, explain them. `summary`: what you changed and why, in two or three sentences.",
    "`files`: per changed file (path relative to its repository, or absolute), why it changed; optionally `symbols`:",
    "a function, method (`Class.method`), type or Markdown section by name, with why that part changed.",
    "Call it once, at the end of a turn in which you changed files. Unknown paths come back in `unknown`.",
  ].join(" "),
  parameters: Schema.Struct({
    summary: Schema.String,
    files: Schema.optional(
      Schema.Array(
        Schema.Struct({
          path: Schema.String,
          explanation: Schema.String,
          symbols: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, explanation: Schema.String }))),
        }),
      ),
    ),
  }),
  success: Schema.Struct({
    attached: Schema.Number,
    unknown: Schema.Array(Schema.String),
    /** The files Apollo sees changed in this turn so far, `<repo>/<path>`. */
    changed: Schema.Array(Schema.String),
  }),
}).annotate(Tool.Destructive, false);

export const ChangeToolkit = Toolkit.make(Explain);

export const handlers = ChangeToolkit.toLayer(
  Effect.gen(function* () {
    const manager = yield* SessionManager;
    return {
      apollo_explain_changes: ({ summary, files }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          if (!summary.trim() && !(files ?? []).length) {
            return yield* new ApolloError({ code: "invalid", message: "summary and files are empty" });
          }
          const result = yield* manager.explainChanges(
            caller.sessionId,
            summary.slice(0, 2000),
            (files ?? []).slice(0, 200).map((f) => ({
              path: f.path,
              explanation: f.explanation.slice(0, 2000),
              symbols: (f.symbols ?? []).slice(0, 100).map((s) => ({ name: s.name, explanation: s.explanation.slice(0, 1000) })),
            })),
          );
          return { attached: result.attached, unknown: result.unknown, changed: result.changed.slice(0, 200) };
        }),
    };
  }),
);
