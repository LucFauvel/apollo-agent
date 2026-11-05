import type {
  ApprovalDecision,
  InputAction,
  InputField,
  MessageAuthor,
  SessionEvent,
  SessionId,
} from "@apollo/contracts";
import { useEffect, useReducer } from "react";
import { follow } from "./rpc.ts";

export type TranscriptItem =
  | { readonly kind: "user"; readonly key: string; readonly text: string; readonly author: MessageAuthor }
  | { readonly kind: "assistant"; readonly key: string; readonly text: string; readonly streaming: boolean }
  | { readonly kind: "reasoning"; readonly key: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly name: string;
      readonly summary: string;
      readonly output: string | null;
      readonly isError: boolean;
    }
  | {
      readonly kind: "approval";
      readonly key: string;
      readonly requestId: string;
      readonly title: string;
      readonly detail: string;
      readonly decision: ApprovalDecision | null;
    }
  | {
      readonly kind: "input";
      readonly key: string;
      readonly requestId: string;
      readonly source: string;
      readonly message: string;
      readonly url: string | null;
      readonly fields: ReadonlyArray<InputField>;
      readonly action: InputAction | null;
    }
  | { readonly kind: "notice"; readonly key: string; readonly level: string; readonly message: string }
  | { readonly kind: "turn-end"; readonly key: string; readonly outcome: string; readonly error: string | null };

interface TranscriptState {
  readonly sessionId: SessionId;
  readonly lastSeq: number;
  readonly items: ReadonlyArray<TranscriptItem>;
}

const updateWhere = (
  items: ReadonlyArray<TranscriptItem>,
  match: (item: TranscriptItem) => boolean,
  update: (item: TranscriptItem) => TranscriptItem,
): ReadonlyArray<TranscriptItem> | null => {
  for (let i = items.length - 1; i >= 0; i--) {
    if (match(items[i]!)) {
      const next = items.slice();
      next[i] = update(items[i]!);
      return next;
    }
  }
  return null;
};

export const reduceTranscript = (state: TranscriptState, e: SessionEvent): TranscriptState => {
  // Persisted events arrive in order; skip anything already applied.
  if (e.seq !== 0 && e.seq <= state.lastSeq) return state;
  const lastSeq = e.seq === 0 ? state.lastSeq : e.seq;
  const event = e.event;
  const items = state.items;
  const push = (item: TranscriptItem) => ({ ...state, lastSeq, items: [...items, item] });

  switch (event._tag) {
    case "UserMessage":
      return push({ kind: "user", key: `u${e.seq}`, text: event.text, author: event.author });
    case "AssistantDelta": {
      const updated = updateWhere(
        items,
        (i) => i.kind === "assistant" && i.key === event.itemId,
        (i) => (i.kind === "assistant" ? { ...i, text: i.text + event.text } : i),
      );
      return updated
        ? { ...state, items: updated }
        : push({ kind: "assistant", key: event.itemId, text: event.text, streaming: true });
    }
    case "AssistantMessage": {
      const updated = updateWhere(
        items,
        (i) => i.kind === "assistant" && i.key === event.itemId,
        () => ({ kind: "assistant", key: event.itemId, text: event.text, streaming: false }),
      );
      return updated
        ? { ...state, lastSeq, items: updated }
        : push({ kind: "assistant", key: event.itemId, text: event.text, streaming: false });
    }
    case "Reasoning":
      return push({ kind: "reasoning", key: `r${e.seq}`, text: event.text });
    case "ToolStarted":
      return push({
        kind: "tool",
        key: event.itemId,
        name: event.name,
        summary: event.summary,
        output: null,
        isError: false,
      });
    case "ToolCompleted": {
      const updated = updateWhere(
        items,
        (i) => i.kind === "tool" && i.key === event.itemId,
        (i) => (i.kind === "tool" ? { ...i, output: event.output, isError: event.isError } : i),
      );
      return updated ? { ...state, lastSeq, items: updated } : { ...state, lastSeq };
    }
    case "ApprovalRequested":
      return push({
        kind: "approval",
        key: `a${event.requestId}`,
        requestId: event.requestId,
        title: event.title,
        detail: event.detail,
        decision: null,
      });
    case "ApprovalResolved": {
      const updated = updateWhere(
        items,
        (i) => i.kind === "approval" && i.requestId === event.requestId,
        (i) => (i.kind === "approval" ? { ...i, decision: event.decision } : i),
      );
      return updated ? { ...state, lastSeq, items: updated } : { ...state, lastSeq };
    }
    case "InputRequested":
      return push({
        kind: "input",
        key: `i${event.requestId}`,
        requestId: event.requestId,
        source: event.source,
        message: event.message,
        url: event.url,
        fields: event.fields,
        action: null,
      });
    case "InputResolved": {
      const updated = updateWhere(
        items,
        (i) => i.kind === "input" && i.requestId === event.requestId,
        (i) => (i.kind === "input" ? { ...i, action: event.action } : i),
      );
      return updated ? { ...state, lastSeq, items: updated } : { ...state, lastSeq };
    }
    case "Notice":
      return push({ kind: "notice", key: `n${e.seq}`, level: event.level, message: event.message });
    case "TurnCompleted":
      return event.outcome === "completed"
        ? { ...state, lastSeq }
        : push({ kind: "turn-end", key: `t${e.seq}`, outcome: event.outcome, error: event.error });
    case "TurnStarted":
      return { ...state, lastSeq };
  }
};

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
