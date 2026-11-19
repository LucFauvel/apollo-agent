import {
  ApolloError,
  type BotId,
  type PullRequest,
  type PullRequestReviews,
  type PullRequestReviewsChange,
  type ReviewComment,
  type SessionId,
} from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Database } from "../Database.ts";
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";
import { type GhCheck, type GhComment, type GhPullRequest, GitHub } from "./GitHub.ts";

const POLL_EVERY = Duration.seconds(60);
const BODY_LIMIT = 4000;
/** Hidden in GitHub's rendering; marks the replies Apollo posted so it never answers itself. */
export const REPLY_MARKER = "<!-- apollo-agent -->";

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

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

type Summary = ReturnType<typeof summarize>;
type Digest = { state: string; checks: string; review: string | null; reviews: number; comments: number };

const header = (pr: PullRequest) => `[Apollo] Pull request ${pr.repo}#${pr.number} "${pr.title}" (${pr.url}) changed:`;

/**
 * What changed since the last look, one line each. With `withComments` false, review
 * comments are left out: the comment tracker reports them (see `newCommentLines`).
 */
const changeLines = (before: string, now: Summary, withComments: boolean): Array<string> => {
  if (!before || before === now.digest) return [];
  const old = JSON.parse(before) as Digest;
  const { summary: pr } = now;
  const lines: Array<string> = [];
  if (old.state !== pr.state && (pr.state === "merged" || pr.state === "closed")) lines.push(`It was ${pr.state}.`);
  const checks = now.digest.match(/"checks":"([^"]*)"/)?.[1] ?? "";
  if (old.checks !== checks && pr.checks === "failing") lines.push(`CI checks failed: ${now.failing.join(", ")}.`);
  if (old.checks !== checks && pr.checks === "passing") lines.push("All CI checks passed.");
  for (const review of now.reviews.slice(old.reviews)) {
    // With comments tracked, a review's summary is one of them, and an empty "commented" review only holds inline comments.
    if (!withComments && (review.body?.trim() || review.state === "COMMENTED")) continue;
    lines.push(`New review from ${review.author?.login ?? "someone"} (${review.state.toLowerCase()})${review.body ? `: ${review.body.slice(0, 600)}` : "."}`);
  }
  if (withComments) {
    for (const comment of now.comments.slice(old.comments)) {
      lines.push(`New comment from ${comment.author?.login ?? "someone"}: ${(comment.body ?? "").slice(0, 600)}`);
    }
  }
  if (old.review !== pr.review && pr.review === "approved" && !lines.some((l) => l.includes("approved"))) lines.push("It was approved.");
  return lines;
};

/** What changed since the last look, as a message for the agent; `null` when nothing worth waking it for. */
export const describeChange = (before: string, now: Summary): string | null => {
  const lines = changeLines(before, now, true);
  return lines.length === 0 ? null : [header(now.summary), ...lines.map((l) => `- ${l}`)].join("\n");
};

const commentId = (c: Pick<GhComment, "kind" | "id">) => `${c.kind}:${c.id}`;

/** Whether the agent should act on a new comment, rather than just hear about it. */
const actionable = (c: GhComment) => {
  if (c.kind === "review") return c.state === "CHANGES_REQUESTED" || c.state === "COMMENTED";
  // Bots on the conversation are CI, coverage and deploy reports; bots reviewing code are reviewers.
  if (c.kind === "conversation") return !c.bot;
  return true;
};

/**
 * Adds the comments GitHub lists that Apollo has not seen. Empty review summaries and
 * Apollo's own replies are skipped. `baseline`: the PR was just linked, so what is there
 * already is left alone. Returns every comment, and the new ones.
 */
export const mergeComments = (
  known: ReadonlyArray<ReviewComment>,
  fetched: ReadonlyArray<GhComment>,
  options: { readonly baseline: boolean; readonly autoAddress: boolean; readonly open: boolean },
) => {
  const ids = new Set(known.map((c) => c.id));
  const replies = new Set(known.flatMap((c) => (c.reply ? [c.reply.id] : [])));
  const fresh: Array<ReviewComment> = [];
  for (const c of [...fetched].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    const id = commentId(c);
    if (ids.has(id) || !c.body.trim() || c.body.includes(REPLY_MARKER) || replies.has(String(c.id))) continue;
    ids.add(id);
    fresh.push({
      id,
      kind: c.kind,
      author: c.author,
      body: c.body.slice(0, BODY_LIMIT),
      path: c.path,
      line: c.line,
      url: c.url,
      createdAt: Date.parse(c.createdAt) || Date.now(),
      ...(c.kind === "inline" && c.inReplyTo ? { threadRoot: c.inReplyTo } : {}),
      status: options.baseline ? "earlier" : options.autoAddress && options.open && actionable(c) ? "queued" : "manual",
      reply: null,
      commit: null,
    });
  }
  return { comments: [...known, ...fresh], fresh };
};

const where = (c: ReviewComment) => (c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ""}` : c.kind === "review" ? " (review)" : "");

/** Where to post a reply to `comment`: inline replies go to the first comment of its thread. */
export const replyTarget = (comment: ReviewComment) => {
  const [kind, id] = comment.id.split(":") as [ReviewComment["kind"], string];
  return { kind, id: kind === "inline" && comment.threadRoot ? comment.threadRoot : Number(id) };
};

/** Lines for the agent about new comments: the ones to address with their ids and how, the rest as news. */
export const newCommentLines = (fresh: ReadonlyArray<ReviewComment>) => {
  const queued = fresh.filter((c) => c.status === "queued");
  const news = fresh.filter((c) => c.status === "manual").map((c) => `- New comment from ${c.author}${where(c)}: ${c.body.slice(0, 600)}`);
  if (queued.length === 0) return news;
  return [
    ...news,
    "",
    "New review comments to address (auto-address is on for this PR; the user can turn it off):",
    ...queued.map((c) => `- [${c.id}] ${c.author}${where(c)}: ${c.body.slice(0, 1500)}`),
    "",
    "Address each one. If it asks for a change, make it, commit and push to the PR's branch, then call",
    "apollo_pr_reply with outcome \"addressed\" and the commit SHA. If it is a question, answer it with outcome",
    "\"answered\". If you disagree, say why with outcome \"declined\". Reply once to each comment listed: replies",
    "are posted on GitHub under the user's account.",
  ];
};

/** The reply as posted on GitHub: the agent's words, the fix, and a mark that an agent wrote it. */
export const replyBody = (comment: ReviewComment, body: string, commit: string | null) =>
  [
    comment.kind === "inline" ? null : `> ${comment.author}: ${comment.body.split("\n")[0]!.slice(0, 200)}\n`,
    body.trim(),
    commit ? `\nFixed in ${commit}.` : null,
    `\n<sub>Posted by an Apollo agent.</sub>`,
    REPLY_MARKER,
  ]
    .filter((l) => l !== null)
    .join("\n");

/**
 * Pull requests linked to sessions. Watched ones are polled with the GitHub CLI;
 * when checks settle, reviews or comments arrive, or the PR is merged or closed,
 * the session gets a message (which starts a turn) and the UI updates. With
 * auto-address on, new review comments are queued for the agent to fix or answer
 * (apollo_pr_reply), and what it did about each is kept and shown.
 */
const make = Effect.gen(function* () {
  const db = yield* Database;
  const store = yield* Store;
  const manager = yield* SessionManager;
  const github = yield* GitHub;
  const reviewChanges = yield* PubSub.unbounded<PullRequestReviewsChange>();

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

  type ReviewRow = { session_id: string; url: string; auto_address: number; ask: number; comments: string; seen: string; undelivered: string };
  const toReviews = (row: ReviewRow): PullRequestReviews => ({
    url: row.url,
    sessionId: row.session_id as SessionId,
    autoAddress: row.auto_address === 1,
    ask: row.ask === 1,
    comments: JSON.parse(row.comments) as Array<ReviewComment>,
  });
  /** How many reviews and comments GitHub listed when the comments were last read: they are read again when that changes. */
  const seenCounts = (now: Summary) => `${now.reviews.length}:${now.comments.length}`;
  const seenOf = (sessionId: SessionId, url: string) =>
    (db.prepare("select seen from pull_request_reviews where session_id = ? and url = ?").get(sessionId, url) as { seen: string } | undefined)?.seen ?? "";
  const setSeen = (sessionId: SessionId, url: string, seen: string) =>
    db.prepare("update pull_request_reviews set seen = ? where session_id = ? and url = ?").run(seen, sessionId, url);
  const undeliveredOf = (sessionId: SessionId, url: string) =>
    JSON.parse(
      (db.prepare("select undelivered from pull_request_reviews where session_id = ? and url = ?").get(sessionId, url) as { undelivered: string } | undefined)
        ?.undelivered ?? "[]",
    ) as Array<string>;
  const setUndelivered = (sessionId: SessionId, url: string, ids: ReadonlyArray<string>) =>
    db.prepare("update pull_request_reviews set undelivered = ? where session_id = ? and url = ?").run(JSON.stringify(ids), sessionId, url);
  const allReviews = () => (db.prepare("select * from pull_request_reviews").all() as Array<ReviewRow>).map(toReviews);
  const loadReviews = (sessionId: SessionId, url: string) => {
    const row = db.prepare("select * from pull_request_reviews where session_id = ? and url = ?").get(sessionId, url) as ReviewRow | undefined;
    return row ? toReviews(row) : null;
  };
  const putReviews = (reviews: PullRequestReviews) =>
    Effect.gen(function* () {
      db.prepare(
        `insert into pull_request_reviews (session_id, url, auto_address, ask, comments) values (?, ?, ?, ?, ?)
         on conflict (session_id, url) do update set auto_address = excluded.auto_address, ask = excluded.ask, comments = excluded.comments`,
      ).run(reviews.sessionId, reviews.url, reviews.autoAddress ? 1 : 0, reviews.ask ? 1 : 0, JSON.stringify(reviews.comments));
      yield* PubSub.publish(reviewChanges, { _tag: "PullRequestReviewsUpserted", reviews });
    });

  /**
   * Turns auto-address on or off, which answers the question if the user was asked; on goes
   * to one session per PR, so two agents never answer the same comment.
   */
  const withAutoAddress = (reviews: PullRequestReviews, enabled: boolean): PullRequestReviews => ({
    ...reviews,
    autoAddress: enabled,
    ask: false,
    comments: enabled ? reviews.comments : reviews.comments.map((c) => (c.status === "queued" ? { ...c, status: "manual" as const } : c)),
  });
  const applyAutoAddress = (reviews: PullRequestReviews, enabled: boolean) =>
    Effect.gen(function* () {
      if (enabled) {
        for (const other of allReviews()) {
          if (other.url === reviews.url && other.sessionId !== reviews.sessionId && other.autoAddress) yield* putReviews(withAutoAddress(other, false));
        }
      }
      const next = withAutoAddress(reviews, enabled);
      yield* putReviews(next);
      return next;
    });

  const publish = (pr: PullRequest) => manager.publish({ _tag: "PullRequestUpserted", pullRequest: pr });

  /**
   * Records what is on the PR when it is first linked, so only comments after that are
   * addressed. Auto-address starts off: the first time a PR is linked anywhere, the user is
   * asked (on every device) whether to turn it on. Nothing waits for the answer. A session
   * linking a PR another one has it on for takes it over.
   */
  const startReviews = (sessionId: SessionId, pr: PullRequest, seen: string) =>
    Effect.gen(function* () {
      const fetched = yield* github.comments(pr.repo, pr.number);
      // Decided after the fetch: a link or poll may have started tracking it meanwhile.
      const existing = loadReviews(sessionId, pr.url);
      if (existing) return existing;
      const others = allReviews().filter((r) => r.url === pr.url);
      const enabled = others.some((r) => r.autoAddress);
      // Only watched PRs get new comments to address (merged, closed and unwatched ones do not).
      const ask = others.length === 0 && pr.watched;
      const { comments } = mergeComments([], fetched, { baseline: true, autoAddress: false, open: true });
      const reviews = enabled
        ? yield* applyAutoAddress({ url: pr.url, sessionId, autoAddress: true, comments }, true)
        : { url: pr.url, sessionId, autoAddress: false, ask, comments };
      if (!enabled) yield* putReviews(reviews);
      setSeen(sessionId, pr.url, seen);
      if (ask) {
        const session = yield* store.getSession(sessionId);
        yield* manager.publish({
          _tag: "Notify",
          botId: session.botId,
          sessionId,
          title: `Auto-address reviews on ${pr.repo}#${pr.number}?`,
          body: `"${pr.title}" was linked. Turn on auto-address to let the agent fix or answer new review comments, push, and reply on GitHub under your account.`,
        });
      }
      return reviews;
    });

  const link = (caller: { botId: BotId; sessionId: SessionId }, url: string, watch: boolean) =>
    Effect.gen(function* () {
      const session = yield* store.getSession(caller.sessionId);
      if (session.botId !== caller.botId) return yield* invalid("that session belongs to another bot");
      const now = summarize(caller.sessionId, yield* github.view(url.trim()), watch);
      const watched = watch && now.summary.state !== "merged" && now.summary.state !== "closed";
      const pr = { ...now.summary, watched };
      save(pr, now.digest);
      yield* publish(pr);
      const reviews = loadReviews(caller.sessionId, pr.url);
      if (!reviews) {
        yield* startReviews(caller.sessionId, pr, seenCounts(now)).pipe(Effect.catch((error) => Effect.logWarning(`could not read the comments on ${pr.url}`, error)));
      } else if (reviews.autoAddress) {
        // Linking again (after a push, say) takes the PR back if another session had it.
        yield* applyAutoAddress(reviews, true);
      }
      const state = loadReviews(caller.sessionId, pr.url);
      return {
        ...pr,
        failingChecks: now.failing,
        pendingChecks: now.pending,
        autoAddress: state?.autoAddress ?? false,
        autoAddressAsked: state?.ask ?? false,
      };
    });

  const unlink = (sessionId: SessionId, url: string) =>
    Effect.gen(function* () {
      db.prepare("delete from pull_requests where session_id = ? and url = ?").run(sessionId, url);
      db.prepare("delete from pull_request_reviews where session_id = ? and url = ?").run(sessionId, url);
      yield* manager.publish({ _tag: "PullRequestRemoved", url, sessionId });
      yield* PubSub.publish(reviewChanges, { _tag: "PullRequestReviewsRemoved", url, sessionId });
    });

  const setAutoAddress = (sessionId: SessionId, url: string, enabled: boolean) =>
    Effect.gen(function* () {
      const reviews = loadReviews(sessionId, url);
      if (!reviews) return yield* new ApolloError({ code: "not_found", message: "that pull request is not linked to this session" });
      yield* applyAutoAddress(reviews, enabled);
    });

  /** Posts the agent's reply to a review comment on GitHub and records what it did. */
  const reply = (
    caller: { botId: BotId; sessionId: SessionId },
    input: { url: string; commentId: string; outcome: "addressed" | "answered" | "declined"; body: string; commit?: string | undefined },
  ) =>
    Effect.gen(function* () {
      const url = input.url.trim();
      const reviews = loadReviews(caller.sessionId, url);
      const linked = db.prepare("select data from pull_requests where session_id = ? and url = ?").get(caller.sessionId, url) as { data: string } | undefined;
      if (!reviews || !linked) return yield* invalid("link this pull request to your session first (apollo_pr_link)");
      if (!reviews.autoAddress) {
        return yield* invalid("the user turned off auto-address for this pull request: do not reply on GitHub unless they ask you to");
      }
      const comment = reviews.comments.find((c) => c.id === input.commentId);
      if (!comment) return yield* invalid(`no comment ${input.commentId} on this pull request; use the ids Apollo sent you`);
      if (comment.reply) return yield* invalid(`you already replied to ${input.commentId}: ${comment.reply.url}`);
      if (!input.body.trim()) return yield* invalid("the reply is empty");
      const commit = input.commit?.trim() || null;
      if (input.outcome === "addressed" && !commit) return yield* invalid("outcome addressed needs the commit you pushed");
      const pr = JSON.parse(linked.data) as PullRequest;
      const text = replyBody(comment, input.body, commit);
      const posted = yield* github.reply(pr.repo, pr.number, replyTarget(comment), text);
      const done: ReviewComment = { ...comment, status: input.outcome, commit, reply: { id: posted.id, body: input.body.trim(), url: posted.url, at: Date.now() } };
      // Read again: the poll may have added comments while the reply was being posted.
      const latest = loadReviews(caller.sessionId, url) ?? reviews;
      yield* putReviews({ ...latest, comments: latest.comments.map((c) => (c.id === done.id ? done : c)) });
      const waiting = latest.comments.filter((c) => c.status === "queued" && c.id !== done.id).map((c) => c.id);
      return { commentId: done.id, status: done.status, replyUrl: posted.url, stillToAddress: waiting };
    });

  /**
   * Sends the agent `lines` plus the new comments it has not been told about yet, this poll's
   * or an earlier one's whose message it could not take (its bot was paused, say). Those stay
   * undelivered until a message goes through.
   */
  const deliver = (sessionId: SessionId, url: string, pr: PullRequest, lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const undelivered = new Set(undeliveredOf(sessionId, url));
      const pending = (loadReviews(sessionId, url)?.comments ?? []).filter(
        (c) => undelivered.has(c.id) && (c.status === "queued" || c.status === "manual"),
      );
      const all = [...lines, ...newCommentLines(pending)];
      if (all.length === 0) {
        // Replied to or turned into earlier ones meanwhile: nothing left to tell.
        if (undelivered.size > 0) setUndelivered(sessionId, url, []);
        return;
      }
      const delivered = yield* manager.send(sessionId, [header(pr), ...all].join("\n"), "system").pipe(
        Effect.as(true),
        Effect.catch((error) => Effect.logWarning(`could not report a change to ${url}; trying again on the next poll`, error).pipe(Effect.as(false))),
      );
      if (delivered || pending.length === 0) {
        setUndelivered(sessionId, url, undeliveredOf(sessionId, url).filter((id) => !undelivered.has(id)));
      }
    });

  const pollOne = (row: { session_id: string; url: string; data: string; digest: string }) =>
    Effect.gen(function* () {
      const known = JSON.parse(row.data) as PullRequest;
      if (!known.watched) {
        // Merged or closed (or unwatched) before the agent could be told about its last comments.
        if (undeliveredOf(known.sessionId, row.url).length > 0) yield* deliver(known.sessionId, row.url, known, []);
        return;
      }
      const fetched = yield* github.view(row.url).pipe(Effect.option);
      if (fetched._tag === "None") return;
      const now = summarize(known.sessionId, fetched.value, true);
      const done = now.summary.state === "merged" || now.summary.state === "closed";
      const pr = { ...now.summary, watched: !done };

      const seen = seenCounts(now);
      let tracked = false;
      if (!loadReviews(known.sessionId, row.url)) {
        tracked = yield* startReviews(known.sessionId, pr, seen).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
      } else if (seenOf(known.sessionId, row.url) !== seen) {
        const comments = yield* github.comments(pr.repo, pr.number).pipe(Effect.option);
        // Read again after the network call: the user may have flipped the switch, or the
        // agent recorded a reply, while GitHub was answering.
        const current = loadReviews(known.sessionId, row.url);
        if (comments._tag === "Some" && current) {
          tracked = true;
          const merged = mergeComments(current.comments, comments.value, { baseline: false, autoAddress: current.autoAddress, open: !done });
          if (merged.fresh.length > 0) {
            yield* putReviews({ ...current, comments: merged.comments });
            setUndelivered(known.sessionId, row.url, [...undeliveredOf(known.sessionId, row.url), ...merged.fresh.map((c) => c.id)]);
          }
          setSeen(known.sessionId, row.url, seen);
        }
      } else {
        tracked = true;
      }

      const settled = loadReviews(known.sessionId, row.url);
      // Nothing left to decide on a merged or closed PR.
      if (done && settled?.ask) yield* putReviews({ ...settled, ask: false });
      const lines = changeLines(row.digest, now, !tracked).map((l) => `- ${l}`);
      save(pr, now.digest);
      if (row.digest !== now.digest || done) yield* publish(pr);
      yield* deliver(known.sessionId, row.url, pr, lines);
    });

  const poll = Effect.suspend(() => Effect.forEach(rows(), pollOne, { discard: true })).pipe(
    Effect.catch((error) => Effect.logWarning("pull request poll failed", error)),
  );

  yield* poll.pipe(Effect.delay(Duration.seconds(10)), Effect.andThen(Effect.repeat(poll, Schedule.spaced(POLL_EVERY))), Effect.forkScoped);

  return {
    link,
    unlink,
    reply,
    setAutoAddress,
    /** Checks every watched PR now (the background poll does this every minute). */
    poll,
    list: Effect.sync(() => rows().map((r) => JSON.parse(r.data) as PullRequest)),
    reviews: (sessionId: SessionId, url: string) => Effect.sync(() => loadReviews(sessionId, url)),
    /** `pullRequests.watch`: every linked PR's review comments, then each change, without gaps. */
    watch: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(reviewChanges);
        const first: PullRequestReviewsChange = { _tag: "PullRequestReviewsSnapshot", reviews: allReviews() };
        return Stream.concat(Stream.succeed(first), Stream.fromSubscription(subscription));
      }),
    ) as Stream.Stream<PullRequestReviewsChange>,
    /** Reads a linked (or any) PR fresh from GitHub, with its failing and pending checks. */
    status: (url: string) =>
      Effect.map(github.view(url), (pr) => {
        const now = summarize("" as SessionId, pr, false);
        const { sessionId: _s, watched: _w, ...rest } = now.summary;
        return { ...rest, failingChecks: now.failing, pendingChecks: now.pending };
      }),
  };
});

export class PullRequests extends Context.Service<PullRequests, Effect.Success<typeof make>>()("apollo/PullRequests") {}

export const layer = Layer.effect(PullRequests, make);
