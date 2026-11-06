import type { SessionEvent, SessionId } from "@apollo/contracts";
import { reduceTranscript, type TranscriptItem, type TranscriptState } from "@apollo/client";
import { useEffect, useReducer } from "react";
import { follow } from "./rpc.ts";

export type { TranscriptItem } from "@apollo/client";

type Action = { readonly type: "event"; readonly event: SessionEvent } | { readonly type: "reset"; readonly sessionId: SessionId };

const reducer = (state: TranscriptState, action: Action): TranscriptState =>
  action.type === "reset"
    ? { sessionId: action.sessionId, lastSeq: 0, items: [] }
    : action.event.sessionId === state.sessionId
      ? reduceTranscript(state, action.event)
      : state;

/** Live transcript for a session: replays history, then follows new events. */
export const useTranscript = (sessionId: SessionId): ReadonlyArray<TranscriptItem> => {
  const [state, dispatch] = useReducer(reducer, { sessionId, lastSeq: 0, items: [] });

  useEffect(() => {
    dispatch({ type: "reset", sessionId });
    let lastSeq = 0;
    return follow(
      (client) => client["sessions.events"]({ sessionId, afterSeq: lastSeq }),
      (event) => {
        if (event.seq > lastSeq) lastSeq = event.seq;
        dispatch({ type: "event", event });
      },
    );
  }, [sessionId]);

  return state.sessionId === sessionId ? state.items : [];
};
