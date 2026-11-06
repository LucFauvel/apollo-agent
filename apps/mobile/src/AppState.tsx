import type { AppChange, AppSnapshot, Bot, BotId, Session, SessionId } from "@apollo/contracts";
import * as Stream from "effect/Stream";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { Connection } from "./connection.ts";

export interface AppState {
  readonly connected: boolean;
  readonly bots: ReadonlyMap<BotId, Bot>;
  readonly sessions: ReadonlyMap<SessionId, Session>;
}

const empty: AppState = { connected: false, bots: new Map(), sessions: new Map() };

type Incoming = ({ readonly _tag: "Snapshot" } & AppSnapshot) | AppChange;

const apply = (state: AppState, item: Incoming): AppState => {
  switch (item._tag) {
    case "Snapshot":
      return {
        connected: true,
        bots: new Map(item.bots.map((b) => [b.id, b])),
        sessions: new Map(item.sessions.map((s) => [s.id, s])),
      };
    case "BotUpserted":
      return { ...state, bots: new Map(state.bots).set(item.bot.id, item.bot) };
    case "BotDeleted": {
      const bots = new Map(state.bots);
      bots.delete(item.botId);
      return { ...state, bots, sessions: new Map([...state.sessions].filter(([, s]) => s.botId !== item.botId)) };
    }
    case "SessionUpserted":
      return { ...state, sessions: new Map(state.sessions).set(item.session.id, item.session) };
    case "SessionDeleted": {
      const sessions = new Map(state.sessions);
      sessions.delete(item.sessionId);
      return { ...state, sessions };
    }
    default:
      return state;
  }
};

const StateContext = createContext<{ state: AppState; connection: Connection } | null>(null);

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
  return <StateContext.Provider value={{ state, connection }}>{children}</StateContext.Provider>;
}

export const useApollo = () => {
  const value = useContext(StateContext);
  if (!value) throw new Error("useApollo outside AppStateProvider");
  return value;
};
