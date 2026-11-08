import type { ApprovalDecision, AttachmentRef, Bot, InputResponse, LocalModel, RepoChanges, Session } from "@apollo/contracts";
import {
  ArrowUp,
  Ban,
  Clock,
  CornerDownLeft,
  Pencil,
  X,
  Brain,
  AppWindow,
  CalendarClock,
  Check,
  ChevronDown,
  CircleAlert,
  GitBranch,
  GitCompareArrows,
  Info,
  Library,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Network,
  Settings2,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import {
  cardsTick,
  currentChangesKey,
  dismissedCards,
  initialCards,
  isCompacting,
  latestChangesKey,
  reduceCards,
  showWorking,
  summariesByTurn,
  systemMessageParts,
} from "@apollo/client";
import { MarkdownText } from "./Code.tsx";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { formatUsage, usageTitle } from "../format.ts";
import { useModelLabel } from "../models.ts";
import { errorMessage, rpc } from "../rpc.ts";
import { dequeue, enqueue, type QueuedMessage, useQueue } from "../queue.ts";
import { useApp } from "../store.ts";
import { type TranscriptItem, useTranscript } from "../transcript.ts";
import { ActivityGroup, type Block, toBlocks } from "./Activity.tsx";
import { SessionSettingsDialog } from "./Dialogs.tsx";
import { ProviderLogo } from "./icons.tsx";
import { InputRequestItem } from "./InputRequest.tsx";
import {
  blockingDownload,
  DownloadProgress,
  downloadPercent,
  LoadProgress,
  splitModelId,
  useLocalModels,
} from "./LocalModelsDialog.tsx";
import { SecretItem } from "./SecretItem.tsx";
import { HandoffItem } from "./HandoffItem.tsx";
import { MessageAttachments, PendingAttachments, useAttachments } from "./Attachments.tsx";
import { RecordingItem } from "./RecordingItem.tsx";
import { FullDiff } from "./FullDiff.tsx";
import { ContextMeter, parseCommand, SlashMenu, useSlashCommands } from "./SlashCommands.tsx";
import { VisualItem } from "./VisualItem.tsx";
import { ConversationBar, ConversationButton, DictateButton, ReadAloudButton, useConversation } from "./Voice.tsx";
import { BotAvatar } from "./Sidebar.tsx";
import { MentionMenu, PeerMessage, useMentions, WithMentions } from "./Mentions.tsx";
import { DayDivider, groupByDay, MessageTime } from "./DayGroups.tsx";
import { MessageRail, type RailTurn } from "./MessageRail.tsx";
import { Badge, Button, Collapse, cx, IconButton, Menu, ModelChip, providerName, StatusDot, statusLabel, Tooltip } from "./ui.tsx";

export type PanelKind = "knowledge" | "schedules" | "browser" | "changes";

function ApprovalItem({
  item,
  onRespond,
}: {
  item: Extract<TranscriptItem, { kind: "approval" }>;
  onRespond: (requestId: string, decision: ApprovalDecision) => void;
}) {
  const pending = item.decision === null;
  return (
    <div
      className={cx(
        "animate-fade-up rounded-xl border p-3.5 text-sm transition-colors duration-300",
        pending ? "border-amber-600/40 bg-amber-950/20 shadow-[0_0_0_4px_rgba(245,158,11,0.04)]" : "border-zinc-800 bg-zinc-900/30",
      )}
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className={cx("size-4 shrink-0", pending ? "text-amber-300" : "text-zinc-500")} strokeWidth={1.75} />
        <div className={cx("min-w-0 flex-1 font-medium", pending ? "text-amber-100" : "text-zinc-400")}>{item.title}</div>
        {!pending ? (
          <Badge tone={item.decision === "decline" ? "red" : "emerald"}>
            {item.decision === "decline" ? "Declined" : item.decision === "accept-for-session" ? "Allowed for session" : "Allowed"}
          </Badge>
        ) : null}
      </div>
      {item.detail ? (
        <pre className="mt-2.5 max-h-60 overflow-auto rounded-lg bg-black/30 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-zinc-300">
          {item.detail}
        </pre>
      ) : null}
      {pending ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="primary" onClick={() => onRespond(item.requestId, "accept")}>
            <Check /> Allow
          </Button>
          <Button size="sm" onClick={() => onRespond(item.requestId, "accept-for-session")}>
            Allow for session
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto text-red-300 hover:text-red-200" onClick={() => onRespond(item.requestId, "decline")}>
            <Ban /> Decline
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface Responders {
  readonly approval: (requestId: string, decision: ApprovalDecision) => void;
  readonly input: (requestId: string, response: InputResponse) => void;
}

/**
 * Keeps a message out of the bot's memory (session search and reflection), or puts it
 * back. Shown on hover; always shown, as a label, once the message is excluded.
 */
function MemoryToggle({
  sessionId,
  seq,
  excluded,
  align,
}: {
  sessionId: Session["id"];
  seq: number;
  excluded: boolean;
  align: "start" | "end";
}) {
  const [busy, setBusy] = useState(false);
  const toggle = () => {
    setBusy(true);
    rpc((c) => c["sessions.setMemoryExclusion"]({ sessionId, seq, excluded: !excluded }))
      .catch((e) => alert(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Tooltip
      align={align}
      content={
        excluded ? (
          <>
            <span className="block font-medium text-zinc-100">Not in memory</span>
            Session search and reflection skip this message. Click to include it again.
          </>
        ) : (
          <>
            <span className="block font-medium text-zinc-100">Exclude from memory</span>
            Session search and reflection will skip this message. This conversation is not changed.
          </>
        )
      }
    >
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-label={excluded ? "Include in memory" : "Exclude from memory"}
      className={cx(
        "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-all",
        excluded
          ? "text-amber-300/80 hover:bg-amber-500/10 hover:text-amber-200"
          : "text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-300 focus-visible:opacity-100",
      )}
    >
      {excluded ? <BrainOff /> : <Brain className="size-3.5" />}
      {excluded ? "Not in memory" : null}
    </button>
    </Tooltip>
  );
}

/** A brain with a slash through it (lucide has no brain-off). */
function BrainOff() {
  return (
    <span className="relative flex size-3.5 items-center justify-center">
      <Brain className="size-3.5" />
      <span className="absolute h-[1.5px] w-[18px] rotate-[-45deg] rounded bg-current" />
    </span>
  );
}

/**
 * A message from the orchestrator or from Apollo (worker reports, job and PR updates):
 * collapsed to its first line, with the rest rendered as markdown when opened.
 */
function SystemMessage({ author, text }: { author: string; text: string }) {
  const [open, setOpen] = useState(false);
  const { first, body } = systemMessageParts(text);
  return (
    <div className="animate-fade-up rounded-xl border border-zinc-800/80 bg-zinc-900/40 text-sm">
      <button
        type="button"
        onClick={() => body && setOpen(!open)}
        aria-expanded={open}
        className={cx("flex w-full min-w-0 items-center gap-2 px-3.5 py-2 text-left", body && "hover:bg-zinc-900/60")}
      >
        {author === "bot" ? <Network className="size-3.5 shrink-0 text-zinc-500" /> : <Info className="size-3.5 shrink-0 text-zinc-500" />}
        <span className="shrink-0 text-[11px] font-medium text-zinc-500">{author === "bot" ? "Orchestrator" : "Apollo"}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">{first}</span>
        {body ? <ChevronDown className={cx("size-3.5 shrink-0 text-zinc-500 transition-transform duration-200", open && "rotate-180")} /> : null}
      </button>
      {body ? (
        <Collapse open={open}>
          <div className="markdown border-t border-zinc-800/80 px-3.5 py-2.5 text-sm leading-relaxed text-zinc-300">
            <MarkdownText>{body}</MarkdownText>
          </div>
        </Collapse>
      ) : null}
    </div>
  );
}

function Item({
  item,
  respond,
  live,
  sessionId,
  onOpenChanges,
  cards,
}: {
  item: Block;
  respond: Responders;
  live: boolean;
  sessionId: Session["id"];
  onOpenChanges: () => void;
  cards: ChangesCards;
}) {
  switch (item.kind) {
    case "changes":
      if (item.report && item.repos[0]) {
        return <FullDiff sessionId={sessionId} seq={item.seq} repo={item.repos[0]} report={item.report} at={item.at} />;
      }
      if (cards.dismissed.has(item.seq)) {
        return cards.justCleared.has(item.seq) ? <ClearedChanges onUndo={() => cards.setDismissed(item.seq, false)} /> : null;
      }
      return (
        <TurnChanges
          repos={item.repos}
          summary={item.turnSeq === null ? null : (cards.summaries.get(item.turnSeq) ?? null)}
          current={cards.current === item.key}
          generation={cards.generation}
          onOpen={onOpenChanges}
          onClear={() => cards.setDismissed(item.seq, true)}
        />
      );
    case "compacting":
      return null; // shown as the working row at the end
    case "visual":
      return <VisualItem item={item} />;
    case "recording":
      return <RecordingItem item={item} />;
    case "secret":
      return <SecretItem item={item} sessionId={sessionId} />;
    case "handoff":
      return <HandoffItem item={item} sessionId={sessionId} />;
    case "activity":
      return <ActivityGroup block={item} live={live} />;
    case "user":
      if (item.author === "peer") return <PeerMessage botId={item.fromBotId} text={item.text} />;
      if (item.author !== "user") return <SystemMessage author={item.author} text={item.text} />;
      return (
        <div className="group animate-fade-up scroll-mt-12 space-y-1.5 pt-2" data-turn={item.key}>
          {item.attachments?.length ? <MessageAttachments sessionId={sessionId} attachments={item.attachments} /> : null}
          {item.text ? (
            <div className="flex items-center justify-end gap-1.5">
              <MessageTime at={item.at} />
              <MemoryToggle sessionId={sessionId} seq={item.seq} excluded={item.excluded ?? false} align="end" />
              <div
                className={cx(
                  "max-w-[85%] rounded-2xl rounded-br-md bg-zinc-800 px-3.5 py-2 text-sm whitespace-pre-wrap text-zinc-100 transition-opacity",
                  item.excluded && "opacity-45",
                )}
              >
                <WithMentions text={item.text} />
              </div>
            </div>
          ) : null}
        </div>
      );
    case "assistant":
      // A scheduled run or heartbeat with nothing to report.
      if (!item.streaming && item.text.trim() === "[SILENT]") {
        return <div className="text-[11px] text-zinc-600 italic">Nothing to report.</div>;
      }
      return (
        <div className="group animate-fade-up">
          <div className={cx("markdown py-1 text-sm leading-relaxed text-zinc-200 transition-opacity", item.excluded && "opacity-45")}>
            <MarkdownText>{item.text}</MarkdownText>
            {item.streaming ? <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-zinc-400 align-middle" /> : null}
          </div>
          {!item.streaming && item.seq ? (
            <div className="-mt-0.5 flex h-6 items-center gap-0.5">
              <MemoryToggle sessionId={sessionId} seq={item.seq} excluded={item.excluded ?? false} align="start" />
              <ReadAloudButton text={item.text} />
              <MessageTime at={item.at} className="ml-1" />
            </div>
          ) : null}
        </div>
      );
    case "approval":
      return <ApprovalItem item={item} onRespond={respond.approval} />;
    case "input":
      return <InputRequestItem item={item} onRespond={respond.input} />;
    case "notice":
      return (
        <div className={cx("flex items-start gap-1.5 px-2 text-xs", item.level === "error" ? "text-red-400" : "text-zinc-500")}>
          {item.level === "error" ? <CircleAlert className="mt-px size-3.5 shrink-0" /> : <Info className="mt-px size-3.5 shrink-0" />}
          <span className="min-w-0">{item.message}</span>
        </div>
      );
    case "turn-end":
      return (
        <div className={cx("flex items-center gap-2 py-1 text-[11px]", item.outcome === "failed" ? "text-red-400" : "text-zinc-500")}>
          <span className="h-px flex-1 bg-zinc-800" />
          <span className="max-w-[80%] truncate" title={item.error ?? undefined}>
            {item.outcome === "interrupted" ? "Stopped" : "Turn failed"}
            {item.error ? `: ${item.error}` : ""}
          </span>
          <span className="h-px flex-1 bg-zinc-800" />
        </div>
      );
  }
}

const isBusy = (s: Session) => s.status === "running" || s.status === "waiting-approval" || s.status === "starting";

/**
 * Messages waiting for the running turn to end, each in a dashed box: "Send now" puts it
 * into the running turn instead (to steer it), the pencil brings it back to edit.
 */
function QueuedMessages({
  queue,
  busy,
  status,
  onSendNow,
  onEdit,
  onRemove,
}: {
  queue: ReadonlyArray<QueuedMessage>;
  busy: boolean;
  status: Session["status"];
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (queue.length === 0) return null;
  return (
    <div className="space-y-1.5 px-3 pt-3">
      <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-zinc-500">
        <Clock className="size-3" />
        {busy
          ? `Queued: sends when this turn ends${queue.length > 1 ? ", one per turn" : ""}`
          : status === "error"
            ? "Held: the last turn failed. Send now when ready, or remove it."
            : "Sending…"}
      </div>
      {queue.map((m) => (
        <div
          key={m.id}
          className="animate-pop-in group flex items-start gap-2 rounded-xl border border-dashed border-zinc-700 bg-zinc-900/30 py-1.5 pr-1.5 pl-3"
        >
          <div className="min-w-0 flex-1 py-0.5">
            <p className="line-clamp-3 text-sm whitespace-pre-wrap text-zinc-300">{m.text}</p>
            {m.attachments.length ? (
              <span className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-500">
                <Paperclip className="size-3" /> {m.attachments.length} attachment{m.attachments.length > 1 ? "s" : ""}
              </span>
            ) : null}
          </div>
          <Tooltip content="Send it into the running turn now, to steer what the agent is doing">
            <button
              type="button"
              onClick={() => onSendNow(m.id)}
              className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800"
            >
              <CornerDownLeft className="size-3" /> Send now
            </button>
          </Tooltip>
          <IconButton icon={Pencil} label="Edit" size="sm" onClick={() => onEdit(m.id)} />
          <IconButton icon={X} label="Remove from queue" size="sm" onClick={() => onRemove(m.id)} />
        </div>
      ))}
    </div>
  );
}

function Composer({
  session,
  botName,
  modelLabel,
  waitingFor,
}: {
  session: Session;
  botName: string;
  modelLabel: string | null;
  /** A local model still downloading: the conversation cannot start yet. */
  waitingFor: LocalModel | null;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tick, setTick] = useState(0);
  const busy = isBusy(session);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const files = useAttachments(session.id);
  const slash = useSlashCommands(session, text);
  // `@Name` asks another bot; the picker follows the caret.
  const [caret, setCaret] = useState(0);
  const mention = useMentions(session.botId, text, caret);
  const pickMention = (bot: Bot) => {
    const next = mention.complete(bot);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  // Focus the box when switching sessions.
  useEffect(() => ref.current?.focus(), [session.id]);

  const canSend = (text.trim().length > 0 || files.refs.length > 0) && !files.uploading && waitingFor === null;
  const send = () => {
    const value = text.trim();
    if (!canSend) return;
    // `/compact`, `/clear`… run as commands (unknown ones go to the agent's harness).
    const command = files.refs.length === 0 ? parseCommand(value) : null;
    if (command) {
      setText("");
      setError(null);
      rpc((c) => c["sessions.runCommand"]({ sessionId: session.id, name: command.name, args: command.args })).catch((e) => {
        setError(errorMessage(e));
        setText(value);
      });
      return;
    }
    const attachments = files.refs;
    setText("");
    setError(null);
    files.clear();
    // While the agent works, the message waits for the turn to end (or "Send now" steers).
    if (busy || queue.length > 0) {
      enqueue(session.id, value, attachments);
      return;
    }
    deliver(value, attachments);
  };

  const deliver = (value: string, attachments: ReadonlyArray<AttachmentRef>) =>
    rpc((c) => c["sessions.send"]({ sessionId: session.id, text: value, ...(attachments.length > 0 ? { attachments } : {}) })).catch(
      (e) => {
        setError(errorMessage(e));
        setText(value);
      },
    );

  // Queued messages go out one per turn, once the session is idle.
  const queue = useQueue(session.id);
  const dispatched = useRef<{ at: number; sawBusy: boolean } | null>(null);
  useEffect(() => {
    const pending = dispatched.current;
    if (pending) {
      // Wait until the message just sent has started (and finished) its turn.
      if (busy) pending.sawBusy = true;
      if (!pending.sawBusy && Date.now() - pending.at < 10_000) {
        const retry = setTimeout(() => setTick((t) => t + 1), 1000);
        return () => clearTimeout(retry);
      }
      if (busy) return;
      dispatched.current = null;
    }
    if (busy || session.status !== "idle" || queue.length === 0) return;
    const next = dequeue(session.id, queue[0]!.id);
    if (!next) return;
    dispatched.current = { at: Date.now(), sawBusy: false };
    void deliver(next.text, next.attachments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, session.status, queue, session.id, tick]);

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="mx-auto max-w-3xl">
        {error ? <div className="mb-2 px-1 text-xs text-red-400">{error}</div> : null}
        <ConversationBar session={session} />
        <div
          className={cx(
            "relative rounded-2xl border bg-zinc-900/80 shadow-lg shadow-black/20 transition-colors focus-within:border-zinc-600",
            dragging ? "border-sky-500/70 bg-sky-950/20" : "border-zinc-800",
          )}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files") || waitingFor) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            setDragging(false);
            if (e.dataTransfer.files.length === 0 || waitingFor) return;
            e.preventDefault();
            files.add([...e.dataTransfer.files]);
          }}
        >
          {mention.open ? (
            <MentionMenu matches={mention.matches} selected={mention.selected} onPick={pickMention} />
          ) : slash.open ? (
            <SlashMenu
              matches={slash.matches}
              selected={slash.selected}
              loading={slash.loading}
              onPick={(c) => {
                setText(`/${c.name} `);
                ref.current?.focus();
              }}
            />
          ) : null}
          <QueuedMessages
            queue={queue}
            onSendNow={(id) => {
              const message = dequeue(session.id, id);
              if (message) void deliver(message.text, message.attachments);
            }}
            onEdit={(id) => {
              const message = dequeue(session.id, id);
              if (!message) return;
              setText((current) => (current.trim() ? `${message.text}\n${current}` : message.text));
              ref.current?.focus();
            }}
            onRemove={(id) => dequeue(session.id, id)}
            busy={busy}
            status={session.status}
          />
          <PendingAttachments items={files.items} onRemove={files.remove} />
          <textarea
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files];
              if (pasted.length > 0) {
                e.preventDefault();
                files.add(pasted);
              }
            }}
            ref={ref}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (mention.open) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  mention.move(e.key === "ArrowDown" ? 1 : -1);
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  pickMention(mention.matches[mention.selected]!);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  mention.dismiss();
                  return;
                }
              }
              if (slash.open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                slash.move(e.key === "ArrowDown" ? 1 : -1);
                return;
              }
              // Tab completes the highlighted command; Enter does too, unless it is already complete.
              const pick = slash.open ? slash.matches[slash.selected] : undefined;
              if (pick && (e.key === "Tab" || (e.key === "Enter" && text.trim() !== `/${pick.name}`))) {
                e.preventDefault();
                setText(`/${pick.name} `);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={Math.min(10, Math.max(2, text.split("\n").length))}
            disabled={waitingFor !== null}
            placeholder={
              waitingFor
                ? `Waiting for ${splitModelId(waitingFor.id).name} to finish downloading (${downloadPercent(waitingFor)}%)…`
                : busy
                  ? "Queue a message for when this turn ends…"
                  : session.role === "main"
                    ? `Message ${botName}… (/ for commands, @ to tag a bot)`
                    : "Message this session…"
            }
            className="block max-h-72 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2.5">
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                files.add([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <IconButton icon={Paperclip} label="Attach files (or paste / drop them)" size="sm" disabled={waitingFor !== null} onClick={() => picker.current?.click()} />
            <DictateButton
              disabled={waitingFor !== null}
              onText={(spoken) => {
                setText((current) => (current.trim() ? `${current.trimEnd()} ${spoken}` : spoken));
                ref.current?.focus();
              }}
            />
            <ConversationButton session={session} disabled={waitingFor !== null} />
            <ModelChip provider={session.provider} model={modelLabel ?? providerName(session.provider)} effort={session.effort} className="px-1.5 text-zinc-500" />
            <span className="flex-1" />
            {session.context && session.context.window > 0 ? <ContextMeter context={session.context} /> : null}
            <span className="hidden text-[11px] text-zinc-600 sm:inline">
              <kbd className="font-sans">Enter</kbd> to send · <kbd className="font-sans">Shift+Enter</kbd> for a new line
            </span>
            {busy ? (
              <IconButton
                icon={Square}
                label="Stop this turn"
                className="border border-zinc-700 text-zinc-300"
                onClick={() => rpc((c) => c["sessions.interrupt"]({ sessionId: session.id }))}
              />
            ) : null}
            <button
              type="button"
              aria-label="Send"
              title="Send"
              disabled={!canSend}
              onClick={send}
              className="flex size-8 items-center justify-center rounded-lg bg-zinc-100 text-zinc-900 transition-colors hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              <ArrowUp className="size-4" strokeWidth={2.25} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** What the conversation's changes cards need besides the item itself. */
interface ChangesCards {
  /** The latest turn's card: open without interaction. */
  readonly current: string | null;
  /** The latest card: when a new one arrives, cards opened by hand fold again. */
  readonly generation: string | null;
  readonly summaries: ReadonlyMap<number, string>;
  readonly dismissed: ReadonlySet<number>;
  /** Cleared while this view is open: they offer an undo instead of vanishing. */
  readonly justCleared: ReadonlySet<number>;
  readonly setDismissed: (seq: number, dismissed: boolean) => void;
}

/**
 * The summaries and cleared cards of a session's conversation (kept by the server, so they
 * follow the user across restarts and devices), refetched when its changes move.
 */
function useChangesCards(session: Session, items: ReadonlyArray<{ kind: string; key: string }>, enabled: boolean): ChangesCards {
  // Bumped by the server's ChangesUpdated, and by every reconnect (store.ts).
  const version = useApp((s) => s.changesVersion.get(session.botId) ?? 0);
  const [state, dispatch] = useReducer(reduceCards, session.id, initialCards);
  const shown = useRef(session.id);
  shown.current = session.id;
  useEffect(() => dispatch({ type: "reset", sessionId: session.id }), [session.id]);
  // Refetched when the bot's changes move, and after each request settles (`epoch`).
  const epoch = state.sessionId === session.id ? state.epoch : 0;
  useEffect(() => {
    if (!enabled) return;
    const sessionId = session.id;
    // Issuing it makes every earlier answer for this view stale, whatever started either.
    const fetchId = cardsTick();
    dispatch({ type: "fetching", sessionId, fetchId });
    rpc((c) => c["changes.conversation"]({ sessionId }))
      .then((changes) => dispatch({ type: "fetched", sessionId, fetchId, changes }))
      .catch(() => {}); // the cards still show, without summaries
  }, [session.id, version, enabled, epoch]);
  const current = useMemo(() => currentChangesKey(items), [items]);
  const generation = useMemo(() => latestChangesKey(items), [items]);
  const own = state.sessionId === session.id ? state : initialCards(session.id);
  const summaries = useMemo(() => summariesByTurn(own.server), [own.server]);
  const dismissed = useMemo(() => dismissedCards(own), [own]);
  const setDismissed = (seq: number, value: boolean) => {
    const sessionId = session.id;
    const id = cardsTick();
    dispatch({ type: "requested", sessionId, id, seq, dismissed: value });
    rpc((c) => c["changes.dismiss"]({ sessionId, seq, dismissed: value })).then(
      () => dispatch({ type: "settled", sessionId, id, seq, ok: true, tick: cardsTick() }),
      (e) => {
        dispatch({ type: "settled", sessionId, id, seq, ok: false, tick: cardsTick() });
        if (shown.current === sessionId) alert(errorMessage(e));
      },
    );
  };
  return { current, generation, summaries, dismissed, justCleared: own.justCleared, setDismissed };
}

/**
 * What a turn changed in git repositories (detected by Apollo, not the agent). The latest
 * turn's card is open (the worker's summary and the files); earlier ones fold to one line.
 * "Review" opens the Changes panel; the cross clears the card from the conversation.
 */
function TurnChanges({
  repos,
  summary,
  current,
  generation,
  onOpen,
  onClear,
}: {
  repos: ReadonlyArray<RepoChanges>;
  summary: string | null;
  current: boolean;
  generation: string | null;
  onOpen: () => void;
  onClear: () => void;
}) {
  // Opened or folded by hand until a newer turn's card arrives; then history folds again.
  const [toggled, setToggled] = useState<boolean | null>(null);
  useEffect(() => setToggled(null), [generation]);
  const open = toggled ?? current;
  const files = repos.flatMap((r) => r.files.map((f) => ({ ...f, repo: r.name })));
  const additions = files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const dot = { added: "bg-emerald-400", modified: "bg-amber-400", deleted: "bg-red-400", renamed: "bg-sky-400" } as const;
  const shown = files.slice(0, 12);
  return (
    <div className="animate-fade-up group overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/30 text-xs transition-colors hover:border-zinc-700">
      <div className="flex min-w-0 items-center">
        <button
          type="button"
          onClick={() => setToggled(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 text-left transition-colors hover:bg-zinc-900/60"
        >
          <GitCompareArrows className="size-3.5 shrink-0 text-zinc-500 transition-colors group-hover:text-zinc-300" />
          <span className="shrink-0 text-zinc-300">
            Changed {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          <span className="min-w-0 truncate text-zinc-500">in {repos.map((r) => r.name).join(", ")}</span>
          {!open ? (
            <span className="flex shrink-0 -space-x-0.5">
              {shown.map((f) => (
                <span key={`${f.repo}/${f.path}`} title={`${f.path} (${f.status})`} className={cx("size-1.5 rounded-full ring-2 ring-zinc-950", dot[f.status])} />
              ))}
            </span>
          ) : null}
          {!open && summary ? <Sparkles className="size-3 shrink-0 text-violet-300/80" /> : null}
          <span className="flex-1" />
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
            <span className="text-emerald-400">+{additions}</span> <span className="text-red-400">−{deletions}</span>
          </span>
          <ChevronDown className={cx("size-3.5 shrink-0 text-zinc-500 transition-transform duration-200", open && "rotate-180")} />
        </button>
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 py-2 pr-1.5 pl-2.5 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-900/60 hover:text-zinc-200"
        >
          Review →
        </button>
        <Tooltip align="end" content="Clear from the conversation">
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear from the conversation"
            className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-zinc-600 opacity-0 transition-all group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-300 focus-visible:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      <Collapse open={open}>
        <div className="space-y-2 border-t border-zinc-800/80 px-3 py-2.5">
          {summary ? (
            <div className="flex gap-2 text-[12.5px] leading-relaxed text-zinc-300">
              <Sparkles className="mt-0.5 size-3 shrink-0 text-violet-300/90" />
              <span className="min-w-0 whitespace-pre-wrap">{summary}</span>
            </div>
          ) : null}
          <div className="space-y-0.5">
            {shown.map((f) => {
              const slash = f.path.lastIndexOf("/");
              return (
                <div key={`${f.repo}/${f.path}`} className="flex min-w-0 items-center gap-2" title={`${f.path} (${f.status})`}>
                  <span className={cx("size-1.5 shrink-0 rounded-full", dot[f.status])} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                    {repos.length > 1 ? <span className="text-zinc-600">{f.repo}/</span> : null}
                    <span className="text-zinc-500">{f.path.slice(0, slash + 1)}</span>
                    <span className={cx("text-zinc-300", f.status === "deleted" && "line-through decoration-zinc-600")}>{f.path.slice(slash + 1)}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
                    {f.additions === null ? (
                      <span className="text-zinc-500">binary</span>
                    ) : (
                      <>
                        <span className="text-emerald-400">+{f.additions}</span> <span className="text-red-400">−{f.deletions ?? 0}</span>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
            {files.length > shown.length ? <div className="pl-3.5 text-[11px] text-zinc-500">and {files.length - shown.length} more</div> : null}
          </div>
        </div>
      </Collapse>
    </div>
  );
}

/** Where a card the user just cleared was, while the view is open: a way back. */
function ClearedChanges({ onUndo }: { onUndo: () => void }) {
  return (
    <div className="animate-fade-up flex items-center gap-2 px-2 text-[11px] text-zinc-600">
      <GitCompareArrows className="size-3 shrink-0" />
      <span>Changes cleared</span>
      <button type="button" onClick={onUndo} className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline">
        Undo
      </button>
    </div>
  );
}

/** Shown while the agent works but nothing has streamed yet (or while it compacts its context). */
function WorkingRow({ label = "Working…" }: { label?: string }) {
  return (
    <div key={label} className="animate-fade-up flex items-center gap-2.5 px-2.5 py-1.5 text-xs">
      <Loader2 className="size-3.5 shrink-0 animate-spin text-zinc-500" />
      <span className="shimmer-text">{label}</span>
    </div>
  );
}

export function SessionView({
  session,
  bot,
  panel,
  onTogglePanel,
}: {
  session: Session;
  bot: Bot;
  panel: PanelKind | null;
  onTogglePanel: (panel: PanelKind) => void;
}) {
  const items = useTranscript(session.id);
  const blocks = useMemo(() => toBlocks(items), [items]);
  // Long chats fold by day: the latest day open, earlier ones folded (each can be toggled).
  const days = useMemo(() => groupByDay(blocks), [blocks]);
  const foldOlderDays = blocks.length > 30;
  const [toggledDays, setToggledDays] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setToggledDays(new Set()), [session.id]);
  const isDayOpen = (key: string, index: number) => {
    const byDefault = !foldOlderDays || index === days.length - 1;
    return toggledDays.has(key) ? !byDefault : byDefault;
  };
  // The rail beside the conversation: one tick per message the user sent, with its answer.
  const railTurns = useMemo(() => {
    const turns: Array<RailTurn> = [];
    for (const block of blocks) {
      if (block.kind === "user" && block.author === "user" && block.text.trim()) {
        turns.push({ key: block.key, text: block.text.replace(/\s+/g, " ").trim(), reply: null, at: block.at });
      } else if (block.kind === "assistant" && turns.length > 0 && turns.at(-1)!.reply === null && block.text.trim() !== "[SILENT]") {
        const last = turns.at(-1)!;
        turns[turns.length - 1] = { ...last, reply: block.text.replace(/[#*`>_]+/g, "").replace(/\s+/g, " ").trim().slice(0, 300) };
      }
    }
    return turns;
  }, [blocks]);
  /** Scrolls to a message, opening its day first if it is folded. */
  const jumpToTurn = (key: string) => {
    const dayIndex = days.findIndex((day) => day.blocks.some(({ block }) => block.key === key));
    stick.current = false;
    const scroll = (behavior: ScrollBehavior) => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(key)}"]`);
      if (!el) return false;
      stick.current = false;
      el.scrollIntoView({ block: "start", behavior });
      return true;
    };
    if (dayIndex >= 0 && days.length > 1 && !isDayOpen(days[dayIndex]!.key, dayIndex)) {
      toggleDay(days[dayIndex]!.key, dayIndex);
      // The day opens with an animation: jump once it is laid out, then settle when it has finished.
      let tries = 0;
      const retry = () => !scroll("auto") && tries++ < 20 && requestAnimationFrame(retry);
      requestAnimationFrame(retry);
      setTimeout(() => scroll("smooth"), 320);
    } else scroll("smooth");
  };
  const toggleDay = (key: string, _index: number) =>
    setToggledDays((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // A dot on the Changes button once this conversation changed files.
  const hasChanges = useMemo(() => items.some((item) => item.kind === "changes" && !item.report), [items]);
  // Full-diff reports are not a turn's changes card: they neither fold history nor take its place.
  const turnBlocks = useMemo(() => blocks.filter((b) => !(b.kind === "changes" && b.report)), [blocks]);
  const cards = useChangesCards(session, turnBlocks, hasChanges);
  // Compaction can take minutes on a local model: say so instead of "Working…".
  const compacting = useMemo(() => isCompacting(items), [items]);
  // Between the user's message and the first streamed output (or a finished step and the
  // next) nothing else shows that the agent is at work: say so.
  const lastBlock = blocks.at(-1);
  const pending = showWorking(isBusy(session), session.status === "waiting-approval", lastBlock);
  const busy = isBusy(session);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // The first scroll after opening a session jumps; later ones glide.
  const jump = useRef(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The map itself is stable between changes; a filtered array from the selector would not be.
  const allPullRequests = useApp((s) => s.pullRequests);
  // Open pull requests, counted on the Changes button (an orchestrator's include its workers', as in the panel).
  const allSessions = useApp((s) => s.sessions);
  const openPullRequests = useMemo(() => {
    const ids = new Set(session.role === "main" ? [...allSessions.values()].filter((s) => s.botId === session.botId).map((s) => s.id) : [session.id]);
    const urls = new Set<string>();
    for (const pr of allPullRequests.values()) if (ids.has(pr.sessionId) && (pr.state === "open" || pr.state === "draft")) urls.add(pr.url);
    return urls.size;
  }, [allPullRequests, allSessions, session.id, session.botId, session.role]);
  const modelLabel = useModelLabel(session.provider, session.model);
  const localModels = useLocalModels(session.provider === "llamacpp");
  const waitingFor = session.provider === "llamacpp" ? blockingDownload(localModels, session.model) : null;
  // A local model loading into memory for this session (its model, or the default).
  const loadingModel =
    session.provider === "llamacpp"
      ? (localModels?.models.find(
          (m) => m.status === "loading" && (session.model ? m.id === session.model : m.id === (localModels.defaultModel ?? m.id)),
        ) ?? null)
      : null;
  const botBusy = useApp((s) => [...s.sessions.values()].some((x) => x.botId === bot.id && isBusy(x)));
  const tokens = session.usage.inputTokens + session.usage.outputTokens;
  const scheduleCount = useApp((s) => {
    let n = 0;
    for (const schedule of s.schedules.values()) if (schedule.botId === bot.id && schedule.enabled) n++;
    return n;
  });
  const main = session.role === "main";
  const browserTabs = useApp((s) => {
    let n = 0;
    for (const tab of s.browserTabs.values()) if (tab.botId === bot.id) n++;
    return n;
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: jump.current ? "auto" : "smooth" });
    jump.current = false;
  }, [items]);

  // Start at the bottom of a newly opened session.
  useEffect(() => {
    stick.current = true;
    jump.current = true;
    setActionError(null);
  }, [session.id]);

  const act = (f: Parameters<typeof rpc>[0]) => {
    setActionError(null);
    rpc(f).catch((e) => setActionError(errorMessage(e)));
  };

  useConversation(session, items, setActionError);

  const respond: Responders = {
    approval: (requestId, decision) => act((c) => c["sessions.respondApproval"]({ sessionId: session.id, requestId, decision })),
    input: (requestId, response) => act((c) => c["sessions.respondInput"]({ sessionId: session.id, requestId, response })),
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-zinc-950">
      <header className="app-drag flex h-14 shrink-0 items-center gap-3 border-b border-zinc-800/80 px-4">
        {main ? (
          <BotAvatar avatar={bot.avatar} size="lg" />
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
            <ProviderLogo provider={session.provider} size={18} />
          </span>
        )}
        {/* Keeps room for the name when a side panel narrows the header; the model chip gives way first. */}
        <div className="min-w-28 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-8 truncate text-sm font-semibold text-zinc-100">{main ? bot.name : session.title}</span>
            {main ? <Badge>Orchestrator</Badge> : session.role === "reflection" ? <Badge tone="violet"><Sparkles className="size-2.5" />Reflection</Badge> : null}
            {session.status !== "idle" ? (
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-400">
                <StatusDot status={session.status} />
                {compacting ? "Compacting" : statusLabel[session.status]}
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center gap-2 text-[11px] text-zinc-500">
            {!main ? <span className="shrink-0">{bot.name}</span> : null}
            {!main ? <span className="text-zinc-700">/</span> : null}
            {session.worktree ? (
              <Tooltip
                align="start"
                content={
                  <>
                    <span className="block font-medium text-zinc-100">Own git worktree</span>
                    Branch {session.worktree.branch}
                    {session.worktree.baseBranch ? `, from ${session.worktree.baseBranch}` : ""}. The bot merges, keeps or discards it
                    when the work is done.
                    <span className="mt-1 block font-mono text-[10px] text-zinc-400">{session.worktree.path}</span>
                  </>
                }
              >
                <span className="flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-px font-mono text-emerald-300">
                  <GitBranch className="size-3" />
                  {session.worktree.branch}
                </span>
              </Tooltip>
            ) : (
              <span className="truncate font-mono" title={session.cwd}>
                {session.cwd}
              </span>
            )}
            {tokens > 0 ? (
              <>
                <span className="text-zinc-700">·</span>
                <span className="shrink-0 tabular-nums" title={`This session: ${usageTitle(session.usage)}`}>
                  {formatUsage(session.usage)}
                </span>
              </>
            ) : null}
          </div>
        </div>

        {actionError ? (
          <span className="max-w-60 truncate text-xs text-red-400" title={actionError}>
            {actionError}
          </span>
        ) : null}

        <button
          className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 pr-2 pl-2.5 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
          title="Model, effort and permissions"
          onClick={() => setSettingsOpen(true)}
        >
          <ModelChip provider={session.provider} model={modelLabel ?? providerName(session.provider)} effort={session.effort} className="max-w-56" />
          <ChevronDown className="size-3.5 shrink-0 text-zinc-500" />
        </button>

        {botBusy ? (
          <Button
            size="sm"
            variant="danger"
            title={`Interrupt everything ${bot.name} is running and pause its automated work`}
            onClick={() => act((c) => c["bots.stop"]({ botId: bot.id }))}
          >
            <Square className="fill-current" /> Stop all
          </Button>
        ) : null}

        <div className="flex items-center gap-0.5 border-l border-zinc-800/80 pl-2">
          <IconButton
            icon={GitCompareArrows}
            label={openPullRequests > 0 ? `Changes and pull requests (${openPullRequests} open)` : "Changes and pull requests"}
            active={panel === "changes"}
            onClick={() => onTogglePanel("changes")}
          >
            {openPullRequests > 0 ? (
              <span
                key={openPullRequests}
                className="animate-pop-in absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-emerald-500 text-[9px] font-semibold text-white tabular-nums"
              >
                {openPullRequests}
              </span>
            ) : hasChanges ? (
              <span className="absolute top-1 right-1 size-1.5 rounded-full bg-amber-400 ring-2 ring-zinc-950" />
            ) : null}
          </IconButton>
          <IconButton icon={CalendarClock} label="Schedules" active={panel === "schedules"} onClick={() => onTogglePanel("schedules")}>
            {scheduleCount > 0 ? (
              <span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-sky-500 text-[9px] font-semibold text-white tabular-nums">
                {scheduleCount}
              </span>
            ) : null}
          </IconButton>
          <IconButton icon={AppWindow} label="Browser" active={panel === "browser"} onClick={() => onTogglePanel("browser")}>
            {browserTabs > 0 ? (
              <span className="absolute top-1 right-1 size-1.5 rounded-full bg-emerald-400 ring-2 ring-zinc-950" />
            ) : null}
          </IconButton>
          <IconButton icon={Library} label="Memory and skills" active={panel === "knowledge"} onClick={() => onTogglePanel("knowledge")} />
          <Menu
            icon={MoreHorizontal}
            label="More"
            items={[
              { label: "Session settings", icon: Settings2, onSelect: () => setSettingsOpen(true) },
              ...(session.role !== "reflection"
                ? [
                    {
                      label: "Reflect on this session",
                      icon: Brain,
                      hint: "Extract memories and skill proposals from this session",
                      disabled: session.completedTurns === 0,
                      onSelect: () => act((c) => c["sessions.reflect"]({ sessionId: session.id })),
                    },
                  ]
                : []),
              ...(!main
                ? [
                    {
                      label: "Delete session",
                      icon: Trash2,
                      danger: true,
                      onSelect: () => {
                        if (confirm(`Delete session "${session.title}"?`)) act((c) => c["sessions.delete"]({ sessionId: session.id }));
                      },
                    },
                  ]
                : []),
            ]}
          />
        </div>
        {settingsOpen ? <SessionSettingsDialog bot={bot} session={session} onClose={() => setSettingsOpen(false)} /> : null}
      </header>

      {bot.pausedReason !== null ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-amber-700/30 bg-amber-950/30 px-4 py-2 text-xs">
          <CircleAlert className="size-4 shrink-0 text-amber-300" />
          <span className="text-amber-200">
            <span className="font-medium">{bot.name} is paused:</span> {bot.pausedReason}. Workers will not start or report back
            until you resume. Your messages still go through.
          </span>
          <Button size="sm" className="ml-auto" onClick={() => act((c) => c["bots.resume"]({ botId: bot.id }))}>
            Resume
          </Button>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col">
      {railTurns.length >= 3 ? <MessageRail turns={railTurns} scrollRef={scrollRef} onJump={jumpToTurn} /> : null}
      <div
        ref={scrollRef}
        // Room for the rail, so the conversation never runs under it when the column is narrow.
        className={cx("flex-1 overflow-y-auto", railTurns.length >= 3 && "pl-10")}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="mx-auto max-w-3xl space-y-2 px-4 py-6">
          {items.length === 0 ? (
            <div className="flex flex-col items-center py-24 text-center">
              {main ? <BotAvatar avatar={bot.avatar} size="lg" /> : <ProviderLogo provider={session.provider} size={32} />}
              <div className="mt-4 text-base font-medium text-zinc-200">{main ? `Talk to ${bot.name}` : session.title}</div>
              <p className="mt-1 max-w-sm text-sm text-zinc-500">
                {main ? (
                  <>
                    It can spawn <ProviderLogo provider={bot.defaultWorker.provider} size={12} className="inline align-[-1px]" />{" "}
                    {providerName(bot.defaultWorker.provider)} workers and others, and remembers what it learns.
                  </>
                ) : (
                  "No messages yet."
                )}
              </p>
            </div>
          ) : (
            (() => {
              const render = (block: Block, i: number) => (
                <Item
                  key={block.key}
                  item={block}
                  respond={respond}
                  live={busy && i === blocks.length - 1}
                  sessionId={session.id}
                  onOpenChanges={() => panel !== "changes" && onTogglePanel("changes")}
                  cards={cards}
                />
              );
              // One day: no dividers. Several: a divider per day, earlier days folded when the chat is long.
              if (days.length <= 1) return blocks.map(render);
              return days.map((day, d) => {
                const open = isDayOpen(day.key, d);
                return (
                  <div key={day.key} className="space-y-2">
                    <DayDivider group={day} open={open} onToggle={() => toggleDay(day.key, d)} />
                    <Collapse open={open} className="space-y-2">
                      {day.blocks.map(({ block, index }) => render(block, index))}
                    </Collapse>
                  </div>
                );
              });
            })()
          )}
          {waitingFor ? <DownloadProgress model={waitingFor} /> : null}
          {compacting ? (
            <WorkingRow label="Compacting the conversation…" />
          ) : pending ? (
            loadingModel ? <LoadProgress model={loadingModel} /> : <WorkingRow />
          ) : null}
        </div>
      </div>
      </div>

      {session.role === "reflection" ? null : (
        <Composer key={session.id} session={session} botName={bot.name} modelLabel={modelLabel} waitingFor={waitingFor} />
      )}
    </section>
  );
}
