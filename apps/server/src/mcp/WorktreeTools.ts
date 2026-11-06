import { ApolloError, SessionId } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";
import { McpCaller } from "./Caller.ts";

/** Workers in their own git worktree: inspect what they did, then merge, keep or discard it. */

const shared = {
  failure: ApolloError,
  failureMode: "return" as const,
  dependencies: [McpCaller],
};

const sessionId = Schema.optional(SessionId).annotate({
  description: "The worker session (default: this session, if it has its own worktree).",
});

const Status = Tool.make("apollo_worktree_status", {
  ...shared,
  description:
    "What a worker did in its own worktree: its branch, the commits since it started, uncommitted changes and a diff summary against where it started.",
  parameters: Schema.Struct({ sessionId }),
  success: Schema.Struct({
    branch: Schema.String,
    path: Schema.String,
    repoPath: Schema.String,
    baseBranch: Schema.NullOr(Schema.String),
    exists: Schema.Boolean,
    commits: Schema.Array(Schema.String),
    uncommitted: Schema.Array(Schema.String),
    diffStat: Schema.String,
  }),
}).annotate(Tool.Readonly, true);

const Finish = Tool.make("apollo_worktree_finish", {
  ...shared,
  description: [
    "Finish a worker's worktree once its work is reviewed. `merge`: merge its branch into the main checkout's",
    "current branch (refused if the main checkout has uncommitted changes; a conflicting merge is backed out and",
    "the conflicting files listed). `keep`: remove the worktree but keep the branch (e.g. to open a pull request).",
    "`discard`: remove the worktree and delete the branch. Uncommitted work is committed first for merge and keep.",
    "Ask the user before merging into a branch they did not tell you to change.",
  ].join(" "),
  parameters: Schema.Struct({ sessionId, action: Schema.Literals(["merge", "keep", "discard"]) }),
  success: Schema.Struct({ action: Schema.String, message: Schema.String }),
});

export const WorktreeToolkit = Toolkit.make(Status, Finish);

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

export const handlers = WorktreeToolkit.toLayer(
  Effect.gen(function* () {
    const manager = yield* SessionManager;
    const store = yield* Store;
    /** The bot's own sessions only. */
    const target = (requested: SessionId | undefined) =>
      Effect.gen(function* () {
        const caller = yield* McpCaller;
        const session = yield* store.getSession(requested ?? caller.sessionId);
        if (session.botId !== caller.botId) return yield* invalid("that session belongs to another bot");
        return session.id;
      });
    return {
      apollo_worktree_status: ({ sessionId }) =>
        Effect.gen(function* () {
          const s = yield* manager.worktreeStatus(yield* target(sessionId));
          return {
            branch: s.branch,
            path: s.path,
            repoPath: s.repoPath,
            baseBranch: s.baseBranch,
            exists: s.exists,
            commits: s.commits,
            uncommitted: s.uncommitted,
            diffStat: s.diffStat,
          };
        }),
      apollo_worktree_finish: ({ sessionId, action }) =>
        Effect.gen(function* () {
          const { message } = yield* manager.finishWorktree(yield* target(sessionId), action);
          return { action, message };
        }),
    };
  }),
);
