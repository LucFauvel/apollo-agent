import type { SessionId } from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import { describeChange, summarize } from "./PullRequests.ts";

const session = "ses_1" as SessionId;
const base = {
  number: 42,
  title: "Add docs",
  state: "OPEN",
  isDraft: false,
  url: "https://github.com/acme/app/pull/42",
  reviewDecision: "REVIEW_REQUIRED",
  reviews: [],
  comments: [],
};
const run = (name: string, status: string, conclusion: string | null) => ({ __typename: "CheckRun", name, status, conclusion });

describe("pull request watching", () => {
  it("summarizes checks and reviews", () => {
    const pending = summarize(session, { ...base, statusCheckRollup: [run("build", "IN_PROGRESS", null), run("lint", "COMPLETED", "SUCCESS")] }, true);
    expect(pending.summary).toMatchObject({ repo: "acme/app", number: 42, state: "open", checks: "pending", review: "review_required" });
    expect(pending.pending).toEqual(["build"]);
    const failing = summarize(session, { ...base, statusCheckRollup: [run("build", "COMPLETED", "FAILURE"), run("lint", "COMPLETED", "SUCCESS")] }, true);
    expect(failing.summary.checks).toBe("failing");
    expect(failing.failing).toEqual(["build"]);
    expect(summarize(session, { ...base, statusCheckRollup: [] }, true).summary.checks).toBe("none");
    expect(summarize(session, { ...base, state: "MERGED", statusCheckRollup: [] }, true).summary.state).toBe("merged");
  });

  it("wakes the agent when checks settle, feedback arrives or the PR closes, not while checks run", () => {
    const start = summarize(session, { ...base, statusCheckRollup: [run("build", "QUEUED", null)] }, true);
    const stillRunning = summarize(session, { ...base, statusCheckRollup: [run("build", "IN_PROGRESS", null)] }, true);
    expect(describeChange(start.digest, stillRunning)).toBeNull();

    const failed = summarize(session, { ...base, statusCheckRollup: [run("build", "COMPLETED", "FAILURE")] }, true);
    expect(describeChange(start.digest, failed)).toContain("CI checks failed: build.");

    const reviewed = summarize(
      session,
      {
        ...base,
        reviewDecision: "CHANGES_REQUESTED",
        statusCheckRollup: [run("build", "COMPLETED", "FAILURE")],
        reviews: [{ author: { login: "ada" }, state: "CHANGES_REQUESTED", body: "Please add tests" }],
      },
      true,
    );
    const message = describeChange(failed.digest, reviewed);
    expect(message).toContain("New review from ada (changes_requested): Please add tests");
    expect(message).not.toContain("CI checks");

    const merged = summarize(session, { ...base, state: "MERGED", statusCheckRollup: [run("build", "COMPLETED", "SUCCESS")] }, true);
    expect(describeChange(reviewed.digest, merged)).toContain("It was merged.");
    // Nothing to report the first time a PR is seen.
    expect(describeChange("", merged)).toBeNull();
  });
});
