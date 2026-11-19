import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ProviderKind, PullRequestReviewsChange, ReviewComment } from "@apollo/contracts";
import { ApolloError, ProviderKind as Kinds } from "@apollo/contracts";
import type { Provider } from "@apollo/providers";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AppSettings from "../AppSettings.ts";
import { ServerConfig } from "../Config.ts";
import * as Database from "../Database.ts";
import * as SessionManager from "../SessionManager.ts";
import * as Store from "../Store.ts";
import { type GhComment, type GhPullRequest, GitHub } from "./GitHub.ts";
import { mergeComments, newCommentLines, REPLY_MARKER, replyBody } from "./PullRequests.ts";
import * as PullRequests from "./PullRequests.ts";

const URL = "https://github.com/acme/app/pull/7";

/** GitHub in memory: what Apollo would read and post, without touching a real PR. */
const fakeGitHub = () => {
  const state = {
    comments: [] as Array<GhComment>,
    replies: [] as Array<{ repo: string; number: number; to: { kind: GhComment["kind"]; id: number }; body: string }>,
    nextId: 1000,
    /** Runs while a comments fetch is in flight, before it returns. */
    duringFetch: null as null | (() => Promise<unknown>),
  };
  const view = (): GhPullRequest => ({
    number: 7,
    title: "Add export",
    state: "OPEN",
    isDraft: false,
    url: URL,
    reviewDecision: null,
    statusCheckRollup: [],
    reviews: state.comments.filter((c) => c.kind !== "conversation").map((c) => ({ author: { login: c.author }, state: c.state ?? "COMMENTED", body: c.kind === "review" ? c.body : "" })),
    comments: state.comments.filter((c) => c.kind === "conversation").map((c) => ({ author: { login: c.author }, body: c.body })),
  });
  const add = (c: Partial<GhComment> & Pick<GhComment, "kind" | "body">) => {
    const comment: GhComment = {
      id: state.nextId++,
      author: "ada",
      bot: false,
      path: null,
      line: null,
      url: `${URL}#c${state.nextId}`,
      createdAt: new Date(Date.now() + state.nextId).toISOString(),
      ...c,
    };
    state.comments.push(comment);
    return comment;
  };
  const service = {
    view: () => Effect.sync(view),
    comments: () =>
      Effect.promise(async () => {
        const list = [...state.comments];
        const hook = state.duringFetch;
        state.duringFetch = null;
        if (hook) await hook();
        return list;
      }),
    reply: (repo: string, number: number, to: { kind: GhComment["kind"]; id: number }, body: string) =>
      Effect.suspend(() => {
        // Like GitHub: an inline reply must target the thread's first comment.
        if (to.kind === "inline" && state.comments.find((c) => c.id === to.id)?.inReplyTo) {
          return Effect.fail(new ApolloError({ code: "invalid", message: "could not reply: 422 parent comment is a reply" }));
        }
        state.replies.push({ repo, number, to, body });
        const posted = add({ kind: to.kind === "inline" ? "inline" : "conversation", author: "luc", body, ...(to.kind === "inline" ? { inReplyTo: to.id } : {}) });
        return Effect.succeed({ id: String(posted.id), url: posted.url });
      }),
  };
  return { state, add, layer: Layer.succeed(GitHub, service as unknown as GitHub["Service"]) };
};

/** A provider that records every message its sessions get and ends each turn at once. */
const recording = (kind: ProviderKind, sent: Array<string>): Provider => ({
  kind,
  listModels: Effect.succeed([]),
  open: (_options, emit) =>
    Effect.succeed({
      send: (text: string) =>
        Effect.gen(function* () {
          sent.push(text);
          const agent = (event: AgentEvent) => emit({ _tag: "Event", event });
          yield* agent({ _tag: "TurnStarted" });
          yield* agent({ _tag: "TurnCompleted", outcome: "completed", error: null });
        }),
      interrupt: Effect.void,
      respondApproval: () => Effect.void,
      respondInput: () => Effect.void,
      compact: () => Effect.void,
      commands: Effect.succeed([]),
      reloadSkills: Effect.void,
    }),
});

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "apollo-prs-"));
  const cwd = join(dir, "workspace");
  mkdirSync(cwd);
  const sent: Array<string> = [];
  const github = fakeGitHub();
  const layer = PullRequests.layer.pipe(
    Layer.provideMerge(github.layer),
    Layer.provideMerge(SessionManager.layer),
    Layer.provideMerge(
      Layer.succeed(SessionManager.Providers, Object.fromEntries(Kinds.literals.map((k) => [k, recording(k, sent)])) as Record<ProviderKind, Provider>),
    ),
    Layer.provideMerge(AppSettings.layer),
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(Database.layerMemory),
    Layer.provideMerge(
      Layer.succeed(ServerConfig, {
        host: "127.0.0.1",
        port: 0,
        dataDir: dir,
        webDistDir: null,
        baseUrl: "http://127.0.0.1:0",
        claudeExecutable: undefined,
        browser: { executable: undefined, headless: true },
        llamaCpp: { baseUrl: "http://127.0.0.1:8080", apiKey: null },
        codexExecutable: undefined,
        tailnetAddon: undefined,
        allowedOrigins: [],
        publicUrl: "http://127.0.0.1:0",
        desktopBootstrapToken: undefined,
        storage: { budgetBytes: 1e9, archiveLimit: 2000, detailRetentionMs: 30 * 86_400_000 },
      }),
    ),
  );
  return { cwd, sent, github, layer };
};

const until = (test: () => boolean, ms = 5000) =>
  Effect.promise(async () => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      if (test()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out");
  });

const setup = (cwd: string) =>
  Effect.gen(function* () {
    const manager = yield* SessionManager.SessionManager;
    const prs = yield* PullRequests.PullRequests;
    const changes: Array<PullRequestReviewsChange> = [];
    yield* Stream.runForEach(prs.watch, (c) => Effect.sync(() => void changes.push(c))).pipe(Effect.forkChild({ startImmediately: true }));
    const bot = yield* manager.createBot({
      name: "Builder",
      instructions: "",
      cwd,
      main: { provider: "claude" },
      defaultWorker: { provider: "codex" },
      runtimeMode: "full-access",
      autoLearn: false,
    });
    const worker = yield* manager.createSession({ botId: bot.id, title: "Export", provider: { provider: "codex" } });
    return { manager, prs, bot, worker, changes, caller: { botId: bot.id, sessionId: worker.id } };
  });

const comment = (over: Partial<ReviewComment>): ReviewComment => ({
  id: "inline:1",
  kind: "inline",
  author: "ada",
  body: "Rename this",
  path: "src/a.ts",
  line: 3,
  url: `${URL}#c1`,
  createdAt: 0,
  status: "queued",
  reply: null,
  commit: null,
  ...over,
});

describe("review comments", () => {
  it("queues new comments, leaves earlier ones, empty summaries, approvals, CI bots and Apollo's own replies alone", () => {
    const at = (n: number) => new Date(n * 1000).toISOString();
    const gh = (c: Partial<GhComment> & Pick<GhComment, "kind" | "id" | "body">): GhComment => ({
      author: "ada",
      bot: false,
      path: null,
      line: null,
      url: "",
      createdAt: at(c.id),
      ...c,
    });
    const first = mergeComments([], [gh({ kind: "inline", id: 1, body: "old" })], { baseline: true, autoAddress: true, open: true });
    expect(first.comments.map((c) => c.status)).toEqual(["earlier"]);

    const fetched = [
      gh({ kind: "inline", id: 1, body: "old" }),
      gh({ kind: "inline", id: 2, body: "Use a map", path: "src/x.ts", line: 9 }),
      gh({ kind: "review", id: 3, body: "", state: "COMMENTED" }),
      gh({ kind: "review", id: 4, body: "LGTM", state: "APPROVED" }),
      gh({ kind: "review", id: 5, body: "Needs tests", state: "CHANGES_REQUESTED" }),
      gh({ kind: "conversation", id: 6, body: "Coverage 80%", bot: true, author: "codecov[bot]" }),
      gh({ kind: "conversation", id: 7, body: `Done\n${REPLY_MARKER}` }),
      gh({ kind: "inline", id: 8, body: "Nit", bot: true, author: "copilot[bot]" }),
    ];
    const next = mergeComments(first.comments, fetched, { baseline: false, autoAddress: true, open: true });
    expect(next.fresh.map((c) => [c.id, c.status])).toEqual([
      ["inline:2", "queued"],
      ["review:4", "manual"],
      ["review:5", "queued"],
      ["conversation:6", "manual"],
      ["inline:8", "queued"],
    ]);
    expect(mergeComments(first.comments, fetched, { baseline: false, autoAddress: false, open: true }).fresh.every((c) => c.status === "manual")).toBe(true);
    expect(mergeComments(next.comments, fetched, { baseline: false, autoAddress: true, open: true }).fresh).toEqual([]);

    const lines = newCommentLines(next.fresh).join("\n");
    expect(lines).toContain("- [inline:2] ada on src/x.ts:9: Use a map");
    expect(lines).toContain("apollo_pr_reply");
    expect(lines).toContain("- New comment from codecov[bot]: Coverage 80%");
    expect(newCommentLines(next.fresh.filter((c) => c.status === "manual")).join("\n")).not.toContain("apollo_pr_reply");
  });

  it("marks replies as an agent's, quotes comments outside a thread and links the fix", () => {
    const inline = replyBody(comment({}), "Renamed.", "abc1234");
    expect(inline).toContain("Renamed.");
    expect(inline).toContain("Fixed in abc1234.");
    expect(inline).toContain("Apollo agent");
    expect(inline).toContain(REPLY_MARKER);
    expect(inline).not.toContain("> ada");
    expect(replyBody(comment({ kind: "review", body: "Needs tests\nmore" }), "Added.", null)).toMatch(/^> ada: Needs tests\n/);
  });

  it.live("asks the agent to address new comments, posts its replies and records what it did", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { prs, worker, changes, caller } = yield* setup(f.cwd);
      f.github.add({ kind: "conversation", body: "Before linking" });
      yield* prs.link(caller, URL, true);
      const linked = yield* prs.reviews(worker.id, URL);
      expect(linked).toMatchObject({ autoAddress: true, comments: [{ status: "earlier", body: "Before linking" }] });

      yield* prs.poll;
      expect(f.sent).toEqual([]);

      const ask = f.github.add({ kind: "inline", body: "Rename foo to bar", path: "src/a.ts", line: 4 });
      yield* prs.poll;
      yield* until(() => f.sent.length === 1);
      expect(f.sent[0]).toContain(`[inline:${ask.id}] ada on src/a.ts:4: Rename foo to bar`);
      expect(f.sent[0]).toContain("apollo_pr_reply");

      const notAddressed = yield* Effect.flip(prs.reply(caller, { url: URL, commentId: `inline:${ask.id}`, outcome: "addressed", body: "Done" }));
      expect(notAddressed.message).toContain("commit");
      const result = yield* prs.reply(caller, { url: URL, commentId: `inline:${ask.id}`, outcome: "addressed", body: "Renamed.", commit: "abc1234" });
      expect(result).toMatchObject({ status: "addressed", stillToAddress: [] });
      expect(f.github.state.replies).toHaveLength(1);
      expect(f.github.state.replies[0]).toMatchObject({ repo: "acme/app", number: 7, to: { kind: "inline", id: ask.id } });
      expect(f.github.state.replies[0]!.body).toContain(REPLY_MARKER);

      const again = yield* Effect.flip(prs.reply(caller, { url: URL, commentId: `inline:${ask.id}`, outcome: "answered", body: "Again" }));
      expect(again.message).toContain("already replied");

      const done = (yield* prs.reviews(worker.id, URL))!.comments.find((c) => c.id === `inline:${ask.id}`)!;
      expect(done).toMatchObject({ status: "addressed", commit: "abc1234", reply: { body: "Renamed." } });

      // Its own reply shows up on GitHub: it is not news, and not a comment to address.
      yield* prs.poll;
      expect(f.sent).toHaveLength(1);
      yield* until(() => changes.some((c) => c._tag === "PullRequestReviewsUpserted" && c.reviews.comments.some((x) => x.status === "addressed")));
      expect(changes[0]!._tag).toBe("PullRequestReviewsSnapshot");
    }).pipe(Effect.provide(f.layer));
  });

  it.live("stops when the user turns it off for the PR, and gives the PR to the session that linked it last", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, prs, bot, worker, caller } = yield* setup(f.cwd);
      yield* prs.link(caller, URL, true);
      const queued = f.github.add({ kind: "inline", body: "Fix this" });
      yield* prs.poll;
      yield* until(() => f.sent.length === 1);

      yield* prs.setAutoAddress(worker.id, URL, false);
      const off = yield* prs.reviews(worker.id, URL);
      expect(off).toMatchObject({ autoAddress: false, comments: [{ id: `inline:${queued.id}`, status: "manual" }] });
      const refused = yield* Effect.flip(prs.reply(caller, { url: URL, commentId: `inline:${queued.id}`, outcome: "answered", body: "Ok" }));
      expect(refused.message).toContain("turned off");
      expect(f.github.state.replies).toEqual([]);

      f.github.add({ kind: "conversation", body: "And this?" });
      yield* prs.poll;
      yield* until(() => f.sent.length === 2);
      expect(f.sent[1]).toContain("New comment from ada: And this?");
      expect(f.sent[1]).not.toContain("apollo_pr_reply");

      // Linking again (after a push) does not turn it back on.
      yield* prs.link(caller, URL, true);
      expect((yield* prs.reviews(worker.id, URL))!.autoAddress).toBe(false);

      yield* prs.setAutoAddress(worker.id, URL, true);
      const other = yield* manager.createSession({ botId: bot.id, title: "Follow-up", provider: { provider: "codex" } });
      yield* prs.link({ botId: bot.id, sessionId: other.id }, URL, true);
      expect((yield* prs.reviews(other.id, URL))!.autoAddress).toBe(true);
      expect((yield* prs.reviews(worker.id, URL))!.autoAddress).toBe(false);
    }).pipe(Effect.provide(f.layer));
  });

  it.live("keeps the user's switch and the agent's replies made while GitHub was being read", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { prs, worker, caller } = yield* setup(f.cwd);
      yield* prs.link(caller, URL, true);
      const first = f.github.add({ kind: "inline", body: "Rename this" });
      yield* prs.poll;
      yield* until(() => f.sent.length === 1);

      // The agent replies to the first comment while the poll reads a second one.
      const second = f.github.add({ kind: "inline", body: "And this" });
      f.github.state.duringFetch = () =>
        Effect.runPromise(prs.reply(caller, { url: URL, commentId: `inline:${first.id}`, outcome: "addressed", body: "Done", commit: "abc1234" }));
      yield* prs.poll;
      const afterReply = (yield* prs.reviews(worker.id, URL))!;
      expect(afterReply.comments.find((c) => c.id === `inline:${first.id}`)).toMatchObject({ status: "addressed", reply: { body: "Done" } });
      expect(afterReply.comments.find((c) => c.id === `inline:${second.id}`)?.status).toBe("queued");
      yield* until(() => f.sent.length === 2);

      // The user turns it off while the poll reads a third comment.
      const third = f.github.add({ kind: "inline", body: "Also this" });
      f.github.state.duringFetch = () => Effect.runPromise(prs.setAutoAddress(worker.id, URL, false));
      yield* prs.poll;
      const off = (yield* prs.reviews(worker.id, URL))!;
      expect(off.autoAddress).toBe(false);
      expect(off.comments.find((c) => c.id === `inline:${third.id}`)?.status).toBe("manual");
      yield* until(() => f.sent.length === 3);
      expect(f.sent[2]).toContain("New comment from ada: Also this");
      expect(f.sent[2]).not.toContain("apollo_pr_reply");
    }).pipe(Effect.provide(f.layer));
  });

  it.live("tells the agent about comments it could not take while its bot was paused, once resumed", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { manager, prs, bot, worker, caller } = yield* setup(f.cwd);
      yield* prs.link(caller, URL, true);
      yield* manager.stopBot(bot.id);
      const ask = f.github.add({ kind: "inline", body: "Fix the typo" });
      yield* prs.poll;
      expect(f.sent).toEqual([]);
      expect((yield* prs.reviews(worker.id, URL))!.comments.find((c) => c.id === `inline:${ask.id}`)?.status).toBe("queued");

      // Still paused: nothing new on GitHub, and still not delivered.
      yield* prs.poll;
      expect(f.sent).toEqual([]);

      yield* manager.resumeBot(bot.id);
      yield* prs.poll;
      yield* until(() => f.sent.length === 1);
      expect(f.sent[0]).toContain(`[inline:${ask.id}] ada: Fix the typo`);

      // Delivered once only.
      yield* prs.poll;
      yield* Effect.sleep("50 millis");
      expect(f.sent).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  });

  it.live("answers a reviewer's follow-up in a thread through the thread's first comment", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { prs, worker, caller } = yield* setup(f.cwd);
      const root = f.github.add({ kind: "inline", body: "Why a map?", path: "src/a.ts", line: 2 });
      yield* prs.link(caller, URL, true);
      const followUp = f.github.add({ kind: "inline", body: "Still unsure, can you use a set?", path: "src/a.ts", line: 2, inReplyTo: root.id });
      yield* prs.poll;
      yield* until(() => f.sent.length === 1);
      expect((yield* prs.reviews(worker.id, URL))!.comments.find((c) => c.id === `inline:${followUp.id}`)).toMatchObject({
        status: "queued",
        threadRoot: root.id,
      });
      yield* prs.reply(caller, { url: URL, commentId: `inline:${followUp.id}`, outcome: "addressed", body: "Switched to a set.", commit: "def5678" });
      expect(f.github.state.replies.at(-1)!.to).toEqual({ kind: "inline", id: root.id });
    }).pipe(Effect.provide(f.layer));
  });
});
