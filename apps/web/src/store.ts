import type {
  AppChange,
  AppSnapshot,
  Bot,
  BotId,
  BrowserTab,
  LocalModelsState,
  PullRequest,
  Schedule,
  ScheduleId,
  Session,
  SessionId,
  Usage,
} from "@apollo/contracts";
import * as Stream from "effect/Stream";
import { useSyncExternalStore } from "react";
import { follow } from "./rpc.ts";

export interface AppState {
  readonly connected: boolean;
  readonly bots: ReadonlyMap<BotId, Bot>;
  readonly sessions: ReadonlyMap<SessionId, Session>;
  /** Each bot's usage today. */
  readonly usageToday: ReadonlyMap<BotId, Usage>;
  /** Bumped when memories/skills of a bot (or global, key "global") change. */
  readonly knowledgeVersion: ReadonlyMap<BotId | "global", number>;
  /** llama.cpp engine, server and model library; loaded when first needed. */
  readonly localModels: LocalModelsState | null;
  readonly schedules: ReadonlyMap<ScheduleId, Schedule>;
  /** Open pages in the built-in browser, by tab id. */
  readonly browserTabs: ReadonlyMap<string, BrowserTab>;
  /** Pull requests linked to sessions, keyed `${sessionId} ${url}`. */
  readonly pullRequests: ReadonlyMap<string, PullRequest>;
}

export type Notice = Extract<AppChange, { _tag: "Notify" }>;
const noticeListeners = new Set<(notice: Notice) => void>();

/** Calls `listener` for each notification the server sends while connected. */
export const onNotify = (listener: (notice: Notice) => void) => {
  noticeListeners.add(listener);
  return () => void noticeListeners.delete(listener);
};

let state: AppState = {
  connected: false,
  bots: new Map(),
  sessions: new Map(),
  usageToday: new Map(),
  knowledgeVersion: new Map(),
  localModels: null,
  schedules: new Map(),
  browserTabs: new Map(),
  pullRequests: new Map(),
};
const listeners = new Set<() => void>();

const setState = (next: AppState) => {
  state = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** For non-React code: the current state, and a callback on every change. */
export const getAppState = () => state;
export const subscribeApp = subscribe;

export const useApp = <T>(select: (state: AppState) => T): T =>
  useSyncExternalStore(subscribe, () => select(state));

const bump = (key: BotId | "global") => {
  const versions = new Map(state.knowledgeVersion);
  versions.set(key, (versions.get(key) ?? 0) + 1);
  return versions;
};

const apply = (change: AppChange) => {
  switch (change._tag) {
    case "BotUpserted":
      return setState({ ...state, bots: new Map(state.bots).set(change.bot.id, change.bot) });
    case "BotDeleted": {
      const bots = new Map(state.bots);
      bots.delete(change.botId);
      const sessions = new Map([...state.sessions].filter(([, s]) => s.botId !== change.botId));
      const schedules = new Map([...state.schedules].filter(([, s]) => s.botId !== change.botId));
      const browserTabs = new Map([...state.browserTabs].filter(([, t]) => t.botId !== change.botId));
      return setState({ ...state, bots, sessions, schedules, browserTabs });
    }
    case "SessionUpserted":
      return setState({
        ...state,
        sessions: new Map(state.sessions).set(change.session.id, change.session),
      });
    case "SessionDeleted": {
      const sessions = new Map(state.sessions);
      sessions.delete(change.sessionId);
      return setState({ ...state, sessions });
    }
    case "BotUsageToday":
      return setState({ ...state, usageToday: new Map(state.usageToday).set(change.botId, change.usage) });
    case "MemoryChanged":
    case "SkillChanged":
      return setState({ ...state, knowledgeVersion: bump(change.botId ?? "global") });
    case "LocalModelsChanged":
      return setState({ ...state, localModels: change.state });
    case "ScheduleUpserted":
      return setState({ ...state, schedules: new Map(state.schedules).set(change.schedule.id, change.schedule) });
    case "ScheduleDeleted": {
      const schedules = new Map(state.schedules);
      schedules.delete(change.scheduleId);
      return setState({ ...state, schedules });
    }
    case "BrowserTabUpserted":
      return setState({ ...state, browserTabs: new Map(state.browserTabs).set(change.tab.id, change.tab) });
    case "PullRequestUpserted": {
      const pr = change.pullRequest;
      return setState({ ...state, pullRequests: new Map(state.pullRequests).set(`${pr.sessionId} ${pr.url}`, pr) });
    }
    case "PullRequestRemoved": {
      const pullRequests = new Map(state.pullRequests);
      pullRequests.delete(`${change.sessionId} ${change.url}`);
      return setState({ ...state, pullRequests });
    }
    case "BrowserTabClosed": {
      const browserTabs = new Map(state.browserTabs);
      browserTabs.delete(change.tabId);
      return setState({ ...state, browserTabs });
    }
    case "Notify":
      for (const listener of noticeListeners) listener(change);
      return;
  }
};

/** Sets local-model state from a direct request (changes keep it current afterwards). */
export const setLocalModels = (localModels: LocalModelsState) => setState({ ...state, localModels });

type Incoming = ({ readonly _tag: "Snapshot" } & AppSnapshot) | AppChange;

/** Starts syncing app state; each (re)connection begins with a fresh snapshot. */
export const startSync = () =>
  follow(
    (client) =>
      Stream.concat(
        Stream.fromEffect(client["app.snapshot"]()).pipe(
          Stream.map((snapshot): Incoming => ({ _tag: "Snapshot", ...snapshot })),
        ),
        client["app.changes"]() as Stream.Stream<Incoming>,
      ),
    (item) => {
      if (item._tag === "Snapshot") {
        setState({
          ...state,
          connected: true,
          bots: new Map(item.bots.map((b) => [b.id, b])),
          sessions: new Map(item.sessions.map((s) => [s.id, s])),
          usageToday: new Map(item.usageToday.map((u) => [u.botId, u.usage])),
          schedules: new Map(item.schedules.map((s) => [s.id, s])),
          browserTabs: new Map(item.browserTabs.map((t) => [t.id, t])),
          pullRequests: new Map(item.pullRequests.map((p) => [`${p.sessionId} ${p.url}`, p])),
        });
      } else {
        apply(item);
      }
    },
    () => {
      if (state.connected) setState({ ...state, connected: false });
    },
  );
