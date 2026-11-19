import * as Schema from "effect/Schema";
import { SessionId } from "./domain.ts";

/** A pull request an agent linked to its session; Apollo can watch it on GitHub. */
export const PullRequest = Schema.Struct({
  url: Schema.String,
  sessionId: SessionId,
  repo: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["open", "draft", "merged", "closed"]),
  /** Combined status of its CI checks. */
  checks: Schema.Literals(["none", "pending", "passing", "failing"]),
  review: Schema.NullOr(Schema.Literals(["approved", "changes_requested", "review_required"])),
  /** Watched PRs are polled; changes wake the session. */
  watched: Schema.Boolean,
  updatedAt: Schema.Number,
});
export type PullRequest = typeof PullRequest.Type;

/**
 * What became of a review comment on a linked PR.
 * `earlier`: already there when the PR was linked, left alone. `manual`: arrived while
 * auto-address was off (the agent was only told). `queued`: the agent was asked to address
 * it and has not replied yet. The others: the agent replied on GitHub, after pushing a fix
 * (`addressed`), answering a question (`answered`) or explaining why not (`declined`).
 */
export const ReviewCommentStatus = Schema.Literals(["earlier", "manual", "queued", "addressed", "answered", "declined"]);
export type ReviewCommentStatus = typeof ReviewCommentStatus.Type;

export const ReviewComment = Schema.Struct({
  /** `<kind>:<GitHub id>`, e.g. `inline:1234`. */
  id: Schema.String,
  /** `inline`: on a line of the diff; `review`: a review's summary; `conversation`: on the PR's conversation. */
  kind: Schema.Literals(["inline", "review", "conversation"]),
  author: Schema.String,
  body: Schema.String,
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Number),
  url: Schema.String,
  createdAt: Schema.Number,
  status: ReviewCommentStatus,
  /** The reply the agent posted on GitHub (under the user's account). */
  reply: Schema.NullOr(Schema.Struct({ id: Schema.String, body: Schema.String, url: Schema.String, at: Schema.Number })),
  /** The commit the agent pushed for it. */
  commit: Schema.NullOr(Schema.String),
});
export type ReviewComment = typeof ReviewComment.Type;

/** A linked PR's review comments, and whether the agent addresses new ones on its own. */
export const PullRequestReviews = Schema.Struct({
  url: Schema.String,
  sessionId: SessionId,
  autoAddress: Schema.Boolean,
  comments: Schema.Array(ReviewComment),
});
export type PullRequestReviews = typeof PullRequestReviews.Type;

/**
 * `pullRequests.watch`: every linked PR's review comments, then each change. Its own stream,
 * not an AppChange, so clients built before it keep syncing (see AppChange).
 */
export const PullRequestReviewsChange = Schema.Union([
  Schema.TaggedStruct("PullRequestReviewsSnapshot", { reviews: Schema.Array(PullRequestReviews) }),
  Schema.TaggedStruct("PullRequestReviewsUpserted", { reviews: PullRequestReviews }),
  Schema.TaggedStruct("PullRequestReviewsRemoved", { url: Schema.String, sessionId: SessionId }),
]);
export type PullRequestReviewsChange = typeof PullRequestReviewsChange.Type;
