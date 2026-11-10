import type { SessionEvent, SessionId } from "@apollo/contracts";
import { reduceTranscript, replayBuffer, type TranscriptItem, type TranscriptState } from "@apollo/client";
import { useEffect, useReducer, useRef } from "react";
import { follow } from "./rpc.ts";

export type { TranscriptItem } from "@apollo/client";

type State = TranscriptState & { readonly loaded: boolean };
type Action =
  | { readonly type: "events"; readonly events: ReadonlyArray<SessionEvent> }
  | { readonly type: "loaded"; readonly sessionId: SessionId }
  | { readonly type: "reset"; readonly sessionId: SessionId };

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "reset":
      return { sessionId: action.sessionId, lastSeq: 0, items: [], loaded: false };
    case "loaded":
      return action.sessionId === state.sessionId ? { ...state, loaded: true } : state;
    case "events": {
      const events = action.events.filter((event) => event.sessionId === state.sessionId);
      return events.length ? { ...events.reduce(reduceTranscript, state as TranscriptState), loaded: state.loaded } : state;
    }
  }
};

/**
 * Live transcript for a session: replays history in batches, then follows new events.
 * `loaded` turns true once the replay has caught up.
 */
export const useTranscript = (
  sessionId: SessionId,
  looksEmpty: boolean,
): { readonly items: ReadonlyArray<TranscriptItem>; readonly loaded: boolean } => {
  const [state, dispatch] = useReducer(reducer, { sessionId, lastSeq: 0, items: [], loaded: false });
  const looksEmptyRef = useRef(looksEmpty);
  looksEmptyRef.current = looksEmpty;

  useEffect(() => {
    dispatch({ type: "reset", sessionId });
    // The buffer lives as long as this stream (reconnects included), so it resumes after
    // the last event received.
    let lastSeq = 0;
    const buffer = replayBuffer<SessionEvent>({
      onBatch: (events) => dispatch({ type: "events", events }),
      onCaughtUp: () => dispatch({ type: "loaded", sessionId }),
      timing: looksEmptyRef.current ? { emptyMs: 300 } : {},
    });
    const stop = follow(
      (client) => client["sessions.events"]({ sessionId, afterSeq: lastSeq }),
      (event) => {
        if (event.seq > lastSeq) lastSeq = event.seq;
        buffer.push(event);
      },
    );
    return () => {
      stop();
      buffer.dispose();
    };
  }, [sessionId]);

  return state.sessionId === sessionId ? state : { items: [], loaded: false };
};
