import {
  type Bot,
  type BotId,
  DEFAULT_BOT_LIMITS,
  EMPTY_USAGE,
  type Session,
  type SessionId,
  type SessionRole,
} from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Database from "./Database.ts";
import * as Store from "./Store.ts";

const layer = Store.layer.pipe(Layer.provideMerge(Database.layerMemory));

const bot = (id: string): Bot => ({
  id: id as BotId,
  name: id,
  instructions: "",
  cwd: "/tmp",
  main: { provider: "claude" },
  defaultWorker: { provider: "codex" },
  runtimeMode: "full-access",
  autoLearn: false,
  limits: DEFAULT_BOT_LIMITS,
  pausedReason: null,
  mainSessionId: `${id}-main` as SessionId,
  createdAt: 0,
  updatedAt: 0,
});

const session = (id: string, botId: string, role: SessionRole = "worker"): Session => ({
  id: id as SessionId,
  botId: botId as BotId,
  role,
  parentSessionId: null,
  title: id,
  provider: "codex",
  model: null,
  effort: null,
  runtimeMode: null,
  cwd: "/tmp",
  status: "idle",
  resumeId: null,
  lastMessage: null,
  completedTurns: 0,
  usage: EMPTY_USAGE,
  createdAt: 0,
  updatedAt: 0,
});

/** Two bots with one session each. */
const seed = Effect.gen(function* () {
  const store = yield* Store.Store;
  yield* store.insertBot(bot("a"));
  yield* store.insertBot(bot("b"));
  yield* store.insertSession(session("a-1", "a"));
  yield* store.insertSession(session("a-2", "a"));
  yield* store.insertSession(session("b-1", "b"));
  return store;
});

describe("core memory", () => {
  it.effect("keeps the user profile global and notes per bot", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      yield* store.setCoreMemory("a" as BotId, "user", ["Prefers pnpm", "  "]);
      yield* store.setCoreMemory("a" as BotId, "notes", ["Repo uses Effect 4"]);
      expect(yield* store.getCoreMemory("b" as BotId)).toEqual({ user: ["Prefers pnpm"], notes: [] });
      expect((yield* store.getCoreMemory("a" as BotId)).notes).toEqual(["Repo uses Effect 4"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses edits over the character budget", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const error = yield* Effect.flip(store.setCoreMemory("a" as BotId, "user", ["x".repeat(1400)]));
      expect(error.message).toContain("1400/1375");
      expect((yield* store.getCoreMemory("a" as BotId)).user).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("memory archive", () => {
  it.effect("refreshes an existing memory instead of saving a duplicate", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const input = { botId: "a" as BotId, kind: "fact" as const, tags: [], sourceSessionId: null };
      const first = yield* store.insertMemory({ ...input, content: "Staging needs the VPN." });
      const again = yield* store.insertMemory({ ...input, content: "staging  needs the vpn" });
      expect(again.id).toBe(first.id);
      expect(again.lastUsedAt).not.toBeNull();
      // Another scope may hold the same text.
      yield* store.insertMemory({ ...input, botId: null, content: "Staging needs the VPN." });
      expect((yield* store.listMemories("a" as BotId)).length).toBe(2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("marks memories as used when a search returns them", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const memory = yield* store.insertMemory({
        botId: "a" as BotId,
        kind: "fact",
        content: "Deploys go through GitHub Actions",
        tags: [],
        sourceSessionId: null,
      });
      expect(memory.lastUsedAt).toBeNull();
      const [found] = yield* store.searchMemories("a" as BotId, "deploys", 5);
      expect(found?.id).toBe(memory.id);
      expect((yield* store.getMemory(memory.id)).lastUsedAt).not.toBeNull();
    }).pipe(Effect.provide(layer)),
  );
});

describe("transcript search", () => {
  it.effect("finds messages from the bot's other sessions only", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      yield* store.insertSession(session("a-reflect", "a", "reflection"));
      yield* store.appendEvent("a-1" as SessionId, { _tag: "UserMessage", text: "the flaky login test", author: "user" });
      yield* store.appendEvent("a-1" as SessionId, {
        _tag: "ToolCompleted",
        itemId: "t",
        output: "login test output",
        isError: false,
      });
      yield* store.appendEvent("a-1" as SessionId, {
        _tag: "AssistantMessage",
        itemId: "m",
        text: "Fixed the flaky login test by awaiting the redirect.",
      });
      yield* store.appendEvent("a-2" as SessionId, { _tag: "UserMessage", text: "login again", author: "user" });
      yield* store.appendEvent("a-reflect" as SessionId, { _tag: "UserMessage", text: "login transcript", author: "system" });
      yield* store.appendEvent("b-1" as SessionId, { _tag: "UserMessage", text: "login for bot b", author: "user" });

      const hits = yield* store.searchTranscripts("a" as BotId, "login", 10, "a-2" as SessionId);
      expect(hits.map((h) => [h.sessionId, h.seq])).toEqual(
        expect.arrayContaining([
          ["a-1", 1],
          ["a-1", 3],
        ]),
      );
      expect(hits).toHaveLength(2);
      expect(hits.find((h) => h.seq === 3)?.excerpt).toContain("**login**");

      yield* store.deleteSession("a-1" as SessionId);
      expect(yield* store.searchTranscripts("a" as BotId, "login", 10, null)).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );
});

describe("usage", () => {
  const totals = (input: number, cost = 0) => ({ inputTokens: input, cachedInputTokens: 0, outputTokens: 0, costUsd: cost });

  it.effect("records only what a running total adds, without double counting resumes", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const id = "a-1" as SessionId;
      yield* store.recordUsage(id, totals(100, 1));
      yield* store.recordUsage(id, totals(250, 2));
      // A resumed conversation reports the same running total again.
      yield* store.recordUsage(id, totals(250, 2));
      expect((yield* store.getSession(id)).usage).toEqual(totals(250, 2));

      // The provider started counting afresh (new conversation): all of it is new.
      const { today } = yield* store.recordUsage(id, totals(40, 0.5));
      expect((yield* store.getSession(id)).usage).toEqual(totals(290, 2.5));
      expect(today).toEqual(totals(290, 2.5));
      expect(yield* store.usageToday("b" as BotId)).toEqual(EMPTY_USAGE);
    }).pipe(Effect.provide(layer)),
  );
});
