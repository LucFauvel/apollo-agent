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
