import { ApolloError } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { McpCaller } from "./Caller.ts";

/** Pull requests: link them to the session, and let Apollo watch CI and reviews. */

const shared = {
  failure: ApolloError,
  failureMode: "return" as const,
  dependencies: [McpCaller],
};

const PrFields = {
  url: Schema.String,
  repo: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  checks: Schema.String,
  review: Schema.NullOr(Schema.String),
  failingChecks: Schema.Array(Schema.String),
  pendingChecks: Schema.Array(Schema.String),
};

const Link = Tool.make("apollo_pr_link", {
  ...shared,
  description: [
    "Link a GitHub pull request to this session right after you create or push to it (pass its URL). The user sees",
    "it, with its CI status, on the session. With watch (default true) Apollo checks it every minute and sends you a",
    "message when its CI checks finish (failed or passed), a review or comment arrives, or it is merged or closed,",
    "so you can fix failures or address feedback without polling. Unless the user turned it off for the PR, new",
    "review comments come with ids for you to address and answer with apollo_pr_reply. Uses the GitHub CLI (gh).",
  ].join(" "),
  parameters: Schema.Struct({ url: Schema.String, watch: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ ...PrFields, watched: Schema.Boolean }),
});

const Unwatch = Tool.make("apollo_pr_unwatch", {
  ...shared,
  description: "Stop watching a pull request linked to this session (it stays listed until merged or closed).",
  parameters: Schema.Struct({ url: Schema.String }),
  success: Schema.Struct({ ...PrFields, watched: Schema.Boolean }),
});

const Status = Tool.make("apollo_pr_status", {
  ...shared,
  description: "Read a pull request's state, CI checks (with the names of failing and pending ones) and review decision now.",
  parameters: Schema.Struct({ url: Schema.String }),
  success: Schema.Struct(PrFields),
}).annotate(Tool.Readonly, true);

const Reply = Tool.make("apollo_pr_reply", {
  ...shared,
  description: [
    "Reply on GitHub to a review comment Apollo asked you to address on a linked pull request, by its `commentId`",
    "(e.g. inline:123). `outcome`: addressed (you pushed a fix: pass its `commit` SHA), answered (a question you",
    "answered) or declined (you explain why not). The reply is posted under the user's GitHub account, marked as",
    "coming from an Apollo agent, and the user sees what you did for each comment. Reply once per comment.",
  ].join(" "),
  parameters: Schema.Struct({
    url: Schema.String,
    commentId: Schema.String,
    outcome: Schema.Literals(["addressed", "answered", "declined"]),
    body: Schema.String,
    commit: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    commentId: Schema.String,
    status: Schema.String,
    replyUrl: Schema.String,
    stillToAddress: Schema.Array(Schema.String),
  }),
});

export const PullRequestToolkit = Toolkit.make(Link, Unwatch, Status, Reply);

export const handlers = PullRequestToolkit.toLayer(
  Effect.gen(function* () {
    const prs = yield* PullRequests;
    return {
      apollo_pr_link: ({ url, watch }) => Effect.flatMap(McpCaller, (caller) => prs.link(caller, url, watch ?? true)),
      apollo_pr_unwatch: ({ url }) => Effect.flatMap(McpCaller, (caller) => prs.link(caller, url, false)),
      apollo_pr_status: ({ url }) => prs.status(url),
      apollo_pr_reply: (input) => Effect.flatMap(McpCaller, (caller) => prs.reply(caller, input)),
    };
  }),
);
