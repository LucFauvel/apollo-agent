import type { AppChange, AppSnapshot, Bot, BotId, LocalModelsState, Session, SessionId, Usage } from "@apollo/contracts";
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
}

let state: AppState = {
  connected: false,
  bots: new Map(),
  sessions: new Map(),
  usageToday: new Map(),
  knowledgeVersion: new Map(),
  localModels: null,
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
    case "BotUsageToday":
      return setState({ ...state, usageToday: new Map(state.usageToday).set(change.botId, change.usage) });
    case "MemoryChanged":
    case "SkillChanged":
      return setState({ ...state, knowledgeVersion: bump(change.botId ?? "global") });
    case "LocalModelsChanged":
      return setState({ ...state, localModels: change.state });
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
        });
      } else {
        apply(item);
      }
    },
    () => {
      if (state.connected) setState({ ...state, connected: false });
    },
  );
