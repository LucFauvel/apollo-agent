import type { PullRequest, PullRequestReviews, ReviewComment, SessionId } from "@apollo/contracts";
import { describe, expect, it } from "vitest";
import { applyReviewsChange, autoAddressAsks, prSessionIds, reviewsForPr, reviewsSummary } from "../src/prReviews.ts";

const url = "https://github.com/acme/app/pull/7";
const a = "ses_a" as SessionId;
const b = "ses_b" as SessionId;
const comment = (id: string, status: ReviewComment["status"], createdAt: number): ReviewComment => ({
  id,
  kind: "inline",
  author: "ada",
  body: "x",
  path: "src/a.ts",
  line: 1,
  url,
  createdAt,
  status,
  reply: null,
  commit: null,
});
const reviews = (sessionId: SessionId, autoAddress: boolean, comments: Array<ReviewComment>): PullRequestReviews => ({ url, sessionId, autoAddress, comments });

describe("pull request reviews", () => {
  it("follows the stream: a snapshot, then upserts and removals", () => {
    let state = applyReviewsChange(new Map(), { _tag: "PullRequestReviewsSnapshot", reviews: [reviews(a, true, [])] });
    expect([...state.keys()]).toEqual([`${a} ${url}`]);
    state = applyReviewsChange(state, { _tag: "PullRequestReviewsUpserted", reviews: reviews(b, false, []) });
    expect(state.size).toBe(2);
    state = applyReviewsChange(state, { _tag: "PullRequestReviewsRemoved", url, sessionId: a });
    expect([...state.keys()]).toEqual([`${b} ${url}`]);
  });

  it("shows the session that addresses the PR, newest comments first, without the ones from before linking", () => {
    const all = applyReviewsChange(new Map(), {
      _tag: "PullRequestReviewsSnapshot",
      reviews: [reviews(a, false, []), reviews(b, true, [comment("inline:1", "earlier", 1), comment("inline:2", "addressed", 2), comment("inline:3", "queued", 3)])],
    });
    const shown = reviewsForPr(all, new Set([a, b]), url, a)!;
    expect(shown.sessionId).toBe(b);
    expect(shown.comments.map((c) => c.id)).toEqual(["inline:3", "inline:2"]);
    expect(reviewsSummary(shown.comments)).toBe("1 waiting · 1 fixed");
    expect(reviewsForPr(all, new Set([a]), url, a)).toMatchObject({ sessionId: a, autoAddress: false });
    expect(reviewsForPr(all, new Set(["ses_c" as SessionId]), url, a)).toBeNull();
    expect(reviewsSummary([])).toBeNull();
  });

  it("lists the open PRs still waiting for the user's answer, for an orchestrator its workers' too", () => {
    const pr = (sessionId: SessionId, state: PullRequest["state"]): PullRequest => ({
      url,
      sessionId,
      repo: "acme/app",
      number: 7,
      title: "Add export",
      state,
      checks: "none",
      review: null,
      watched: true,
      updatedAt: 1,
    });
    const reviewsMap = applyReviewsChange(new Map(), {
      _tag: "PullRequestReviewsSnapshot",
      reviews: [{ ...reviews(a, false, []), ask: true }, reviews(b, false, [])],
    });
    const prs = new Map([[`${a} ${url}`, pr(a, "open")], [`${b} ${url}`, pr(b, "open")]]);
    expect(autoAddressAsks(reviewsMap, prs, new Set([a, b])).map((x) => x.sessionId)).toEqual([a]);
    expect(autoAddressAsks(reviewsMap, prs, new Set([b]))).toEqual([]);
    expect(autoAddressAsks(reviewsMap, new Map([[`${a} ${url}`, pr(a, "merged")]]), new Set([a]))).toEqual([]);

    const sessions = [
      { id: a, botId: "bot_1" },
      { id: b, botId: "bot_1" },
      { id: "ses_c" as SessionId, botId: "bot_2" },
    ];
    expect([...prSessionIds({ id: a, botId: "bot_1", role: "main" }, sessions)]).toEqual([a, b]);
    expect([...prSessionIds({ id: b, botId: "bot_1", role: "worker" }, sessions)]).toEqual([b]);
  });
});
