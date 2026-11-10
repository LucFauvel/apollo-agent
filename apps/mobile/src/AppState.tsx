import { invalidateChanges, rollBack, withOrder, withSeenMark } from "@apollo/client";
import type { AppChange, AppSnapshot, Bot, BotId, BrowserTab, Monitor, PullRequest, Session, SessionId } from "@apollo/contracts";
import * as Stream from "effect/Stream";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Connection } from "./connection.ts";

export interface AppState {
  readonly connected: boolean;
  readonly bots: ReadonlyMap<BotId, Bot>;
  readonly sessions: ReadonlyMap<SessionId, Session>;
  /** By `<sessionId> <url>`: a PR can be linked from several sessions. */
  readonly pullRequests: ReadonlyMap<string, PullRequest>;
  /** Bumped when a bot's sessions changed files or explained changes: the Changes screen refetches. */
  readonly changesVersion: ReadonlyMap<BotId, number>;
  /** Open tabs of Apollo's browser, by id. */
  readonly browserTabs: ReadonlyMap<string, BrowserTab>;
  /** Monitors agents set up (apollo_monitor_start), running and recently ended, by id. */
  readonly monitors: ReadonlyMap<string, Monitor>;
  /** When the user last saw each bot's chats, on any device: its notifications up to then are dismissed. */
  readonly notificationsSeen: ReadonlyMap<string, number>;
}

const empty: AppState = {
  connected: false,
  bots: new Map(),
  sessions: new Map(),
  pullRequests: new Map(),
  changesVersion: new Map(),
  browserTabs: new Map(),
  monitors: new Map(),
  notificationsSeen: new Map(),
};

type Incoming = ({ readonly _tag: "Snapshot" } & AppSnapshot) | AppChange;

const apply = (state: AppState, item: Incoming): AppState => {
  switch (item._tag) {
    case "Snapshot":
      return {
        connected: true,
        bots: new Map(item.bots.map((b) => [b.id, b])),
        sessions: new Map(item.sessions.map((s) => [s.id, s])),
        pullRequests: new Map(item.pullRequests.map((pr) => [`${pr.sessionId} ${pr.url}`, pr])),
        // A reconnect may have missed updates: count it as one.
        // (Bots this phone never heard a ChangesUpdated for included: they start from none.)
        changesVersion: invalidateChanges(state.changesVersion, item.bots.map((b) => b.id)),
        browserTabs: new Map(item.browserTabs.map((t) => [t.id, t])),
        // Older servers send no monitors.
        monitors: new Map((item.monitors ?? []).map((m) => [m.id, m])),
        notificationsSeen: (item.notificationsSeen ?? []).reduce((marks, m) => withSeenMark(marks, m.botId, m.at), state.notificationsSeen),
      };
    case "BrowserTabUpserted":
      return { ...state, browserTabs: new Map(state.browserTabs).set(item.tab.id, item.tab) };
    case "BrowserTabClosed": {
      const browserTabs = new Map(state.browserTabs);
      browserTabs.delete(item.tabId);
      return { ...state, browserTabs };
    }
    case "PullRequestUpserted": {
      const pr = item.pullRequest;
      return { ...state, pullRequests: new Map(state.pullRequests).set(`${pr.sessionId} ${pr.url}`, pr) };
    }
    case "PullRequestRemoved": {
      const pullRequests = new Map(state.pullRequests);
      pullRequests.delete(`${item.sessionId} ${item.url}`);
      return { ...state, pullRequests };
    }
    case "MonitorUpserted":
      return { ...state, monitors: new Map(state.monitors).set(item.monitor.id, item.monitor) };
    case "MonitorRemoved": {
      const monitors = new Map(state.monitors);
      monitors.delete(item.monitorId);
      return { ...state, monitors };
    }
    case "NotificationsSeen":
      return { ...state, notificationsSeen: withSeenMark(state.notificationsSeen, item.botId, item.at) };
    case "ChangesUpdated":
      return { ...state, changesVersion: new Map(state.changesVersion).set(item.botId, (state.changesVersion.get(item.botId) ?? 0) + 1) };
    case "BotUpserted":
      return { ...state, bots: new Map(state.bots).set(item.bot.id, item.bot) };
    case "BotDeleted": {
      const bots = new Map(state.bots);
      bots.delete(item.botId);
      return {
        ...state,
        bots,
        sessions: new Map([...state.sessions].filter(([, s]) => s.botId !== item.botId)),
        browserTabs: new Map([...state.browserTabs].filter(([, t]) => t.botId !== item.botId)),
        monitors: new Map([...state.monitors].filter(([, m]) => m.botId !== item.botId)),
      };
    }
    case "SessionUpserted":
      return { ...state, sessions: new Map(state.sessions).set(item.session.id, item.session) };
    case "SessionDeleted": {
      const sessions = new Map(state.sessions);
      sessions.delete(item.sessionId);
      return { ...state, sessions, monitors: new Map([...state.monitors].filter(([, m]) => m.sessionId !== item.sessionId)) };
    }
    default:
      return state;
  }
};

interface Apollo {
  readonly state: AppState;
  readonly connection: Connection;
  /**
   * Puts the bot list in `order` (every bot id, first to last): shown at once, saved with
   * `bots.reorder`, undone if the server refuses (the promise then rejects).
   */
  readonly reorderBots: (order: ReadonlyArray<BotId>) => Promise<void>;
}

const StateContext = createContext<Apollo | null>(null);

/** Bots and sessions, kept in sync with the server (a snapshot, then changes; resumed after drops). */
export function AppStateProvider({ connection, children }: { connection: Connection; children: ReactNode }) {
  // Kept across reconnects: the screen keeps showing the last state while a new socket opens.
  const [state, setState] = useState<AppState>(empty);
  useEffect(
    () =>
      connection.follow(
        (client) =>
          Stream.concat(
            Stream.fromEffect(client["app.snapshot"]()).pipe(Stream.map((s): Incoming => ({ _tag: "Snapshot", ...s }))),
            client["app.changes"]() as Stream.Stream<Incoming>,
          ),
        (item) => setState((s) => apply(s, item)),
        () => setState((s) => ({ ...s, connected: false })),
      ),
    [connection],
  );
  const latest = useRef(state);
  latest.current = state;
  const reorderBots = useCallback(
    async (order: ReadonlyArray<BotId>) => {
      const before = latest.current.bots;
      const optimistic = withOrder(before, order);
      latest.current = { ...latest.current, bots: optimistic };
      setState((s) => ({ ...s, bots: withOrder(s.bots, order) }));
      try {
        await connection.rpc((c) => c["bots.reorder"]({ botIds: order }));
      } catch (error) {
        setState((s) => ({ ...s, bots: rollBack(s.bots, optimistic, before) }));
        throw error;
      }
    },
    [connection],
  );
  return <StateContext.Provider value={{ state, connection, reorderBots }}>{children}</StateContext.Provider>;
}

export const useApollo = () => {
  const value = useContext(StateContext);
  if (!value) throw new Error("useApollo outside AppStateProvider");
  return value;
};
