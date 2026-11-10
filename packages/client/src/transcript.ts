/**
 * Folds a session's event log into the items a client shows (messages, activity,
 * approvals, cards). Shared by the web and phone apps.
 */
import type {
  ArtifactRef,
  AttachmentRef,
  ApprovalDecision,
  ChangeReport,
  InputAction,
  InputField,
  MessageAuthor,
  ReplyRef,
  RepoChanges,
  SessionEvent,
  SessionId,
} from "@apollo/contracts";

/** Every item carries when it happened (its event's time), for times and day groups. */
export type TranscriptItem = TranscriptItemKind & { readonly at?: number };

type TranscriptItemKind =
  | {
      readonly kind: "user";
      readonly key: string;
      readonly text: string;
      readonly author: MessageAuthor;
      readonly attachments?: ReadonlyArray<AttachmentRef>;
      /** For `peer` messages: the bot that wrote it. */
      readonly fromBotId?: string;
      readonly replyTo?: ReplyRef;
      /** Position in the session log; `excluded` when kept out of the bot's memory. */
      readonly seq: number;
      readonly excluded?: boolean;
    }
  | {
      readonly kind: "assistant";
      readonly key: string;
      readonly text: string;
      readonly streaming: boolean;
      /** Set once the final message is stored (0 while streaming). */
      readonly seq?: number;
      readonly excluded?: boolean;
    }
  | { readonly kind: "reasoning"; readonly key: string; readonly text: string; readonly streaming?: boolean }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly name: string;
      readonly summary: string;
      readonly output: string | null;
      readonly isError: boolean;
      /** Made by a subagent: the key of the tool call that started it. */
      readonly parent?: string;
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
  | {
      readonly kind: "visual";
      readonly key: string;
      readonly title: string;
      readonly html: string;
      readonly height: number | null;
      readonly artifact?: ArtifactRef;
    }
  | {
      readonly kind: "recording";
      readonly key: string;
      readonly recordingId: string;
      readonly title: string;
      readonly frames: number;
      readonly width: number;
      readonly height: number;
      readonly durationMs: number;
    }
  | {
      readonly kind: "secret";
      readonly key: string;
      readonly requestId: string;
      readonly label: string;
      readonly reason: string;
      readonly placeholder: string | null;
      readonly outcome: "provided" | "declined" | "expired" | null;
      readonly source: "typed" | "1password" | null;
    }
  /** The agent handed the browser to the user and waits (a CAPTCHA, a sign-in to finish). */
  | {
      readonly kind: "handoff";
      readonly key: string;
      readonly requestId: string;
      readonly tabId: string;
      readonly url: string;
      readonly reason: string;
      readonly outcome: "done" | "cancelled" | "expired" | null;
    }
  | { readonly kind: "turn-end"; readonly key: string; readonly outcome: string; readonly error: string | null }
  /**
   * Files a turn changed in git repositories (detected by Apollo). With `report`: the full
   * diff of one repository the user asked for; its files open with `changes.file` and `reportSeq: seq`.
   */
  | {
      readonly kind: "changes";
      readonly key: string;
      readonly repos: ReadonlyArray<RepoChanges>;
      /** The FilesChanged event's seq (what `changes.dismiss` takes). */
      readonly seq: number;
      /** The turn it ended (its TurnStarted seq), to find the worker's summary; null if not seen. */
      readonly turnSeq: number | null;
      readonly report?: ChangeReport;
    }
  /** Live only, while the agent compacts its context; clients show it instead of "Working…". */
  | { readonly kind: "compacting"; readonly key: string };

export interface TranscriptState {
  readonly sessionId: SessionId;
  readonly lastSeq: number;
  readonly items: ReadonlyArray<TranscriptItem>;
  /** Seq of the latest TurnStarted event, for the turn's changes card. */
  readonly turnSeq?: number;
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
  const push = (item: TranscriptItem) => ({ ...state, lastSeq, items: [...items, { ...item, at: e.at }] });

  switch (event._tag) {
    // `/clear`: the chat starts over (the log keeps everything for search and memory).
    case "ConversationCleared":
      return { ...state, lastSeq, items: [] };
    case "UserMessage":
      return push({
        kind: "user",
        key: `u${e.seq}`,
        text: event.text,
        author: event.author,
        seq: e.seq,
        ...(event.attachments ? { attachments: event.attachments } : {}),
        ...(event.fromBotId ? { fromBotId: event.fromBotId } : {}),
        ...(event.replyTo ? { replyTo: event.replyTo } : {}),
      });
    case "MemoryExclusion": {
      const updated = updateWhere(
        items,
        (i) => (i.kind === "user" || i.kind === "assistant") && i.seq === event.seq,
        (i) => (i.kind === "user" || i.kind === "assistant" ? { ...i, excluded: event.excluded } : i),
      );
      return updated ? { ...state, lastSeq, items: updated } : { ...state, lastSeq };
    }
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
        () => ({ kind: "assistant", key: event.itemId, text: event.text, streaming: false, seq: e.seq }),
      );
      return updated
        ? { ...state, lastSeq, items: updated }
        : push({ kind: "assistant", key: event.itemId, text: event.text, streaming: false, seq: e.seq });
    }
    case "ReasoningDelta": {
      const updated = updateWhere(
        items,
        (i) => i.kind === "reasoning" && i.key === event.itemId,
        (i) => (i.kind === "reasoning" ? { ...i, text: i.text + event.text } : i),
      );
      return updated
        ? { ...state, items: updated }
        : push({ kind: "reasoning", key: event.itemId, text: event.text, streaming: true });
    }
    case "Reasoning": {
      const updated = updateWhere(
        items,
        (i) => i.kind === "reasoning" && i.key === event.itemId,
        () => ({ kind: "reasoning", key: event.itemId, text: event.text, streaming: false }),
      );
      return updated ? { ...state, lastSeq, items: updated } : push({ kind: "reasoning", key: event.itemId, text: event.text });
    }
    case "ToolPending":
      return items.some((i) => i.kind === "tool" && i.key === event.itemId)
        ? state
        : push({ kind: "tool", key: event.itemId, name: event.name, summary: "", output: null, isError: false });
    case "ToolStarted": {
      // Fills in a call shown early by ToolPending.
      const updated = updateWhere(
        items,
        (i) => i.kind === "tool" && i.key === event.itemId,
        (i) => (i.kind === "tool" ? { ...i, name: event.name, summary: event.summary } : i),
      );
      return updated
        ? { ...state, lastSeq, items: updated }
        : push({
            kind: "tool",
            key: event.itemId,
            name: event.name,
            summary: event.summary,
            output: null,
            isError: false,
            ...(event.parentItemId ? { parent: event.parentItemId } : {}),
          });
    }
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
    case "Visual":
      return push({
        kind: "visual",
        key: `v${e.seq}`,
        title: event.title,
        html: event.html,
        height: event.height,
        ...(event.artifact ? { artifact: event.artifact } : {}),
      });
    case "Recording":
      return push({
        kind: "recording",
        key: `rec${e.seq}`,
        recordingId: event.recordingId,
        title: event.title,
        frames: event.frames,
        width: event.width,
        height: event.height,
        durationMs: event.durationMs,
      });
    case "SecretRequested":
      return push({
        kind: "secret",
        key: `s${e.seq}`,
        requestId: event.requestId,
        label: event.label,
        reason: event.reason,
        placeholder: event.placeholder,
        outcome: null,
        source: null,
      });
    case "SecretResolved": {
      const updated = updateWhere(
        items,
        (i) => i.kind === "secret" && i.requestId === event.requestId,
        (i) => (i.kind === "secret" ? { ...i, outcome: event.outcome, source: event.source } : i),
      );
      return updated ? { ...state, lastSeq, items: updated } : { ...state, lastSeq };
    }
    case "BrowserHandoff":
      return push({ kind: "handoff", key: `h${e.seq}`, requestId: event.requestId, tabId: event.tabId, url: event.url, reason: event.reason, outcome: null });
    case "BrowserHandoffResolved": {
      const updated = updateWhere(
        items,
        (i) => i.kind === "handoff" && i.requestId === event.requestId,
        (i) => (i.kind === "handoff" ? { ...i, outcome: event.outcome } : i),
      );
      return updated ? { ...state, lastSeq, items: updated } : { ...state, lastSeq };
    }
    case "Notice":
      return push({ kind: "notice", key: `n${e.seq}`, level: event.level, message: event.message });
    case "FilesChanged":
      return push({
        kind: "changes",
        key: `c${e.seq}`,
        repos: event.repos,
        seq: e.seq,
        turnSeq: state.turnSeq ?? null,
        ...(event.report ? { report: event.report } : {}),
      });
    case "Compacting": {
      const rest = items.filter((i) => i.kind !== "compacting");
      return { ...state, items: event.active ? [...rest, { kind: "compacting", key: "compacting" }] : rest };
    }
    case "TurnCompleted": {
      // A turn that ends also ends any compaction it was doing.
      const ended = { ...state, items: items.filter((i) => i.kind !== "compacting") };
      return event.outcome === "completed"
        ? { ...ended, lastSeq }
        : { ...ended, lastSeq, items: [...ended.items, { kind: "turn-end", key: `t${e.seq}`, outcome: event.outcome, error: event.error }] };
    }
    case "TurnStarted":
      return e.seq === 0 ? { ...state, lastSeq } : { ...state, lastSeq, turnSeq: e.seq };
  }
};

