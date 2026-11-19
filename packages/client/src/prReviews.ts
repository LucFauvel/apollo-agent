import type { PullRequestReviews, PullRequestReviewsChange, ReviewComment, ReviewCommentStatus, SessionId } from "@apollo/contracts";

const key = (r: { sessionId: SessionId; url: string }) => `${r.sessionId} ${r.url}`;

/** Applies one item of `pullRequests.watch`, keyed `${sessionId} ${url}` like pull requests. */
export const applyReviewsChange = (
  reviews: ReadonlyMap<string, PullRequestReviews>,
  change: PullRequestReviewsChange,
): ReadonlyMap<string, PullRequestReviews> => {
  if (change._tag === "PullRequestReviewsSnapshot") return new Map(change.reviews.map((r) => [key(r), r]));
  const next = new Map(reviews);
  if (change._tag === "PullRequestReviewsUpserted") next.set(key(change.reviews), change.reviews);
  else next.delete(key(change));
  return next;
};

/**
 * What the panel shows for a PR linked from any of `sessionIds`: the session that addresses
 * its comments (or the given fallback, to turn it on), and the comments since it was linked.
 */
export const reviewsForPr = (
  all: ReadonlyMap<string, PullRequestReviews>,
  sessionIds: ReadonlySet<SessionId>,
  url: string,
  fallback: SessionId,
) => {
  const linked = [...all.values()].filter((r) => r.url === url && sessionIds.has(r.sessionId));
  if (linked.length === 0) return null;
  const owner = linked.find((r) => r.autoAddress) ?? linked.find((r) => r.sessionId === fallback) ?? linked[0]!;
  const comments = [...owner.comments.filter((c) => c.status !== "earlier")].sort((a, b) => b.createdAt - a.createdAt);
  return { sessionId: owner.sessionId, autoAddress: owner.autoAddress, comments };
};

export const REVIEW_STATUS_LABEL: Record<ReviewCommentStatus, string> = {
  earlier: "Before linking",
  manual: "Not addressed",
  queued: "Agent working",
  addressed: "Fixed",
  answered: "Answered",
  declined: "Declined",
};

/** "2 fixed · 1 waiting", or null when there is nothing to tell. */
export const reviewsSummary = (comments: ReadonlyArray<ReviewComment>) => {
  const count = (s: ReviewCommentStatus) => comments.filter((c) => c.status === s).length;
  const parts = [
    [count("queued"), "waiting"],
    [count("addressed"), "fixed"],
    [count("answered"), "answered"],
    [count("declined"), "declined"],
    [count("manual"), "not addressed"],
  ] as const;
  const text = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(" · ");
  return text || null;
};

/** Where a comment sits: `src/a.ts:12`, "review" or "conversation". */
export const reviewCommentPlace = (c: ReviewComment) => (c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : c.kind);
