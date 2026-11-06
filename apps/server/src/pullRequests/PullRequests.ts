import { execFile } from "node:child_process";
import { ApolloError, type BotId, type PullRequest, type SessionId } from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { Database } from "../Database.ts";
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";

const POLL_EVERY = Duration.seconds(60);
const FIELDS = "number,title,state,isDraft,url,headRepository,headRepositoryOwner,reviewDecision,statusCheckRollup,reviews,comments";

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

interface GhCheck {
  readonly __typename?: string;
  readonly name?: string;
  readonly context?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly state?: string;
}

interface GhPullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly url: string;
  readonly reviewDecision: string | null;
  readonly statusCheckRollup: ReadonlyArray<GhCheck> | null;
  readonly reviews: ReadonlyArray<{ author?: { login?: string }; state: string; body?: string; submittedAt?: string }> | null;
  readonly comments: ReadonlyArray<{ author?: { login?: string }; body?: string; createdAt?: string }> | null;
}

const gh = (args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) => {
    execFile("gh", [...args], { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const text = (stderr || error.message).trim();
      reject(
        new Error(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "the GitHub CLI (gh) is not installed; install it and run `gh auth login`"
            : text,
        ),
      );
    });
  });

const FAILED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

const checkName = (c: GhCheck) => c.name ?? c.context ?? "check";
const isPending = (c: GhCheck) =>
  c.__typename === "StatusContext" ? c.state === "PENDING" || c.state === "EXPECTED" : c.status !== "COMPLETED";
const isFailed = (c: GhCheck) => FAILED.has((c.conclusion ?? c.state ?? "").toUpperCase());

/** The PR as Apollo shows it, plus a digest of what changes should wake the agent. */
export const summarize = (sessionId: SessionId, pr: GhPullRequest, watched: boolean) => {
  const checks = pr.statusCheckRollup ?? [];
  const failing = checks.filter(isFailed).map(checkName);
  const pending = checks.filter(isPending).map(checkName);
  const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url)?.[1] ?? "";
  const reviews = pr.reviews ?? [];
  const comments = pr.comments ?? [];
  const summary: PullRequest = {
    url: pr.url,
    sessionId,
    repo,
    number: pr.number,
    title: pr.title,
    state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
    checks: checks.length === 0 ? "none" : pending.length > 0 ? "pending" : failing.length > 0 ? "failing" : "passing",
    review:
      pr.reviewDecision === "APPROVED"
        ? "approved"
        : pr.reviewDecision === "CHANGES_REQUESTED"
          ? "changes_requested"
          : pr.reviewDecision === "REVIEW_REQUIRED"
            ? "review_required"
            : null,
    watched,
    updatedAt: Date.now(),
  };
  // Pending checks are not reported until they settle; new reviews and comments are.
  const digest = JSON.stringify({
    state: summary.state,
    checks: summary.checks === "pending" ? "pending" : `${summary.checks}:${failing.join(",")}`,
    review: summary.review,
    reviews: reviews.length,
    comments: comments.length,
  });
  return { summary, digest, failing, pending, reviews, comments };
};

/** What changed since the last look, as a message for the agent; `null` when nothing worth waking it for. */
export const describeChange = (
  before: string,
  now: ReturnType<typeof summarize>,
): string | null => {
  if (!before || before === now.digest) return null;
  const old = JSON.parse(before) as { state: string; checks: string; review: string | null; reviews: number; comments: number };
  const { summary: pr } = now;
  const lines: Array<string> = [];
  if (old.state !== pr.state && (pr.state === "merged" || pr.state === "closed")) lines.push(`It was ${pr.state}.`);
  const checks = now.digest.match(/"checks":"([^"]*)"/)?.[1] ?? "";
  if (old.checks !== checks && pr.checks === "failing") lines.push(`CI checks failed: ${now.failing.join(", ")}.`);
  if (old.checks !== checks && pr.checks === "passing") lines.push("All CI checks passed.");
  for (const review of now.reviews.slice(old.reviews)) {
    lines.push(`New review from ${review.author?.login ?? "someone"} (${review.state.toLowerCase()})${review.body ? `: ${review.body.slice(0, 600)}` : "."}`);
  }
  for (const comment of now.comments.slice(old.comments)) {
    lines.push(`New comment from ${comment.author?.login ?? "someone"}: ${(comment.body ?? "").slice(0, 600)}`);
  }
  if (old.review !== pr.review && pr.review === "approved" && !lines.some((l) => l.includes("approved"))) lines.push("It was approved.");
  if (lines.length === 0) return null;
  return [`[Apollo] Pull request ${pr.repo}#${pr.number} "${pr.title}" (${pr.url}) changed:`, ...lines.map((l) => `- ${l}`)].join("\n");
};

/**
 * Pull requests linked to sessions. Watched ones are polled with the GitHub CLI;
 * when checks settle, reviews or comments arrive, or the PR is merged or closed,
 * the session gets a message (which starts a turn) and the UI updates.
 */
const make = Effect.gen(function* () {
  const db = yield* Database;
  const store = yield* Store;
  const manager = yield* SessionManager;

  const rows = () =>
    db.prepare("select session_id, url, data, digest from pull_requests").all() as Array<{
      session_id: string;
      url: string;
      data: string;
      digest: string;
    }>;
  const save = (pr: PullRequest, digest: string) =>
    db
      .prepare(
        `insert into pull_requests (session_id, url, data, digest) values (?, ?, ?, ?)
         on conflict (session_id, url) do update set data = excluded.data, digest = excluded.digest`,
      )
      .run(pr.sessionId, pr.url, JSON.stringify(pr), digest);

  const fetch = (url: string) =>
    Effect.tryPromise({
      try: async () => JSON.parse(await gh(["pr", "view", url, "--json", FIELDS])) as GhPullRequest,
      catch: (error) => invalid(`could not read ${url}: ${(error as Error).message}`),
    });

  const publish = (pr: PullRequest) => manager.publish({ _tag: "PullRequestUpserted", pullRequest: pr });

  const link = (caller: { botId: BotId; sessionId: SessionId }, url: string, watch: boolean) =>
    Effect.gen(function* () {
      const session = yield* store.getSession(caller.sessionId);
      if (session.botId !== caller.botId) return yield* invalid("that session belongs to another bot");
      const now = summarize(caller.sessionId, yield* fetch(url.trim()), watch);
      const watched = watch && now.summary.state !== "merged" && now.summary.state !== "closed";
      const pr = { ...now.summary, watched };
      save(pr, now.digest);
      yield* publish(pr);
      return { ...pr, failingChecks: now.failing, pendingChecks: now.pending };
    });

  const unlink = (sessionId: SessionId, url: string) =>
    Effect.gen(function* () {
      db.prepare("delete from pull_requests where session_id = ? and url = ?").run(sessionId, url);
      yield* manager.publish({ _tag: "PullRequestRemoved", url, sessionId });
    });

  const poll = Effect.gen(function* () {
    for (const row of rows()) {
      const known = JSON.parse(row.data) as PullRequest;
      if (!known.watched) continue;
      const fetched = yield* fetch(row.url).pipe(Effect.option);
      if (fetched._tag === "None") continue;
      const now = summarize(known.sessionId, fetched.value, true);
      const done = now.summary.state === "merged" || now.summary.state === "closed";
      const pr = { ...now.summary, watched: !done };
      const message = describeChange(row.digest, now);
      save(pr, now.digest);
      if (row.digest !== now.digest || done) yield* publish(pr);
      if (message) {
        yield* manager.send(known.sessionId, message, "system").pipe(
          Effect.catch((error) => Effect.logWarning(`could not report a change to ${row.url}`, error)),
        );
      }
    }
  }).pipe(Effect.catch((error) => Effect.logWarning("pull request poll failed", error)));

  yield* poll.pipe(Effect.delay(Duration.seconds(10)), Effect.andThen(Effect.repeat(poll, Schedule.spaced(POLL_EVERY))), Effect.forkScoped);

  return {
    link,
    unlink,
    list: Effect.sync(() => rows().map((r) => JSON.parse(r.data) as PullRequest)),
    /** Reads a linked (or any) PR fresh from GitHub, with its failing and pending checks. */
    status: (url: string) =>
      Effect.map(fetch(url), (pr) => {
        const now = summarize("" as SessionId, pr, false);
        const { sessionId: _s, watched: _w, ...rest } = now.summary;
        return { ...rest, failingChecks: now.failing, pendingChecks: now.pending };
      }),
  };
});

export class PullRequests extends Context.Service<PullRequests, Effect.Success<typeof make>>()("apollo/PullRequests") {}

export const layer = Layer.effect(PullRequests, make);
