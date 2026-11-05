import type { AppChange, Bot, BotId, Session, SessionId } from "@apollo/contracts";
import * as Stream from "effect/Stream";
import { useSyncExternalStore } from "react";
import { follow } from "./rpc.ts";

export interface AppState {
  readonly connected: boolean;
  readonly bots: ReadonlyMap<BotId, Bot>;
  readonly sessions: ReadonlyMap<SessionId, Session>;
  /** Bumped when memories/skills of a bot (or global, key "global") change. */
  readonly knowledgeVersion: ReadonlyMap<BotId | "global", number>;
}

let state: AppState = {
  connected: false,
  bots: new Map(),
  sessions: new Map(),
  knowledgeVersion: new Map(),
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
      return setState({ ...state, bots, sessions });
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
    case "MemoryChanged":
    case "SkillChanged":
      return setState({ ...state, knowledgeVersion: bump(change.botId ?? "global") });
  }
};

type Incoming = { readonly _tag: "Snapshot"; readonly bots: ReadonlyArray<Bot>; readonly sessions: ReadonlyArray<Session> } | AppChange;

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
        });
      } else {
        apply(item);
      }
    },
    () => {
      if (state.connected) setState({ ...state, connected: false });
    },
  );
