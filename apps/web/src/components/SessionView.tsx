import type { ApprovalDecision, Bot, InputResponse, LocalModel, PullRequest, Session } from "@apollo/contracts";
import {
  ArrowUp,
  Ban,
  Brain,
  AppWindow,
  CalendarClock,
  Check,
  ChevronDown,
  CircleAlert,
  GitBranch,
  GitMerge,
  GitPullRequest,
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
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatUsage, usageTitle } from "../format.ts";
import { useModelLabel } from "../models.ts";
import { errorMessage, rpc } from "../rpc.ts";
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
import { MessageAttachments, PendingAttachments, useAttachments } from "./Attachments.tsx";
import { RecordingItem } from "./RecordingItem.tsx";
import { ContextMeter, parseCommand, SlashMenu, useSlashCommands } from "./SlashCommands.tsx";
import { VisualItem } from "./VisualItem.tsx";
import { BotAvatar } from "./Sidebar.tsx";
import { Badge, Button, Collapse, cx, IconButton, Menu, ModelChip, providerName, StatusDot, statusLabel, Tooltip } from "./ui.tsx";

export type PanelKind = "knowledge" | "schedules" | "browser";

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
  const [first = "", ...rest] = text.replace(/^\[Apollo\]\s*/, "").split("\n");
  const body = rest.join("\n").trim();
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
            <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
          </div>
        </Collapse>
      ) : null}
    </div>
  );
}

function Item({ item, respond, live, sessionId }: { item: Block; respond: Responders; live: boolean; sessionId: Session["id"] }) {
  switch (item.kind) {
    case "visual":
      return <VisualItem item={item} />;
    case "recording":
      return <RecordingItem item={item} />;
    case "secret":
      return <SecretItem item={item} sessionId={sessionId} />;
    case "activity":
      return <ActivityGroup block={item} live={live} />;
    case "user":
      if (item.author !== "user") return <SystemMessage author={item.author} text={item.text} />;
      return (
        <div className="group animate-fade-up space-y-1.5 pt-2">
          {item.attachments?.length ? <MessageAttachments sessionId={sessionId} attachments={item.attachments} /> : null}
          {item.text ? (
            <div className="flex items-center justify-end gap-1.5">
              <MemoryToggle sessionId={sessionId} seq={item.seq} excluded={item.excluded ?? false} align="end" />
              <div
                className={cx(
                  "max-w-[85%] rounded-2xl rounded-br-md bg-zinc-800 px-3.5 py-2 text-sm whitespace-pre-wrap text-zinc-100 transition-opacity",
                  item.excluded && "opacity-45",
                )}
              >
                {item.text}
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
            <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
            {item.streaming ? <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-zinc-400 align-middle" /> : null}
          </div>
          {!item.streaming && item.seq ? (
            <div className="-mt-0.5 flex h-6 items-center">
              <MemoryToggle sessionId={sessionId} seq={item.seq} excluded={item.excluded ?? false} align="start" />
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
  const busy = isBusy(session);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const files = useAttachments(session.id);
  const slash = useSlashCommands(session, text);

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
    rpc((c) => c["sessions.send"]({ sessionId: session.id, text: value, ...(attachments.length > 0 ? { attachments } : {}) })).catch(
      (e) => {
        setError(errorMessage(e));
        setText(value);
      },
    );
  };

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="mx-auto max-w-3xl">
        {error ? <div className="mb-2 px-1 text-xs text-red-400">{error}</div> : null}
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
          {slash.open ? (
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
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
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
                : session.role === "main"
                ? `Message ${botName}… (/ for commands)`
                : busy
                  ? "Send a follow-up (folded into the running turn)…"
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

const PR_CHECKS: Record<PullRequest["checks"], { label: string; className: string }> = {
  none: { label: "No checks", className: "text-zinc-400" },
  pending: { label: "Checks running", className: "text-amber-300" },
  passing: { label: "Checks passed", className: "text-emerald-300" },
  failing: { label: "Checks failed", className: "text-red-300" },
};

/** A pull request linked to the session: number, CI status and review state; opens it on GitHub. */
function PullRequestChip({ pr }: { pr: PullRequest }) {
  const checks = PR_CHECKS[pr.checks];
  const done = pr.state === "merged" || pr.state === "closed";
  const Icon = pr.state === "merged" ? GitMerge : GitPullRequest;
  return (
    <Tooltip
      align="start"
      content={
        <>
          <span className="block font-medium text-zinc-100">
            {pr.repo}#{pr.number}: {pr.title}
          </span>
          {pr.state === "merged" ? "Merged" : pr.state === "closed" ? "Closed" : pr.state === "draft" ? "Draft" : "Open"} · {checks.label}
          {pr.review ? ` · ${pr.review.replace("_", " ")}` : ""}
          {pr.watched ? <span className="mt-1 block text-zinc-400">Watched: the bot hears about CI results, reviews and comments.</span> : null}
        </>
      }
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className={cx(
          "flex shrink-0 items-center gap-1 rounded-md bg-zinc-800/80 px-1.5 py-px transition-colors hover:bg-zinc-700/80",
          done ? (pr.state === "merged" ? "text-violet-300" : "text-zinc-400") : checks.className,
        )}
      >
        <Icon className="size-3" />#{pr.number}
        {!done && pr.checks === "pending" ? <Loader2 className="size-2.5 animate-spin" /> : null}
      </a>
    </Tooltip>
  );
}

/** Shown while the agent works but nothing has streamed yet. */
function WorkingRow() {
  return (
    <div className="animate-fade-up flex items-center gap-2.5 px-2.5 py-1.5 text-xs">
      <Loader2 className="size-3.5 shrink-0 animate-spin text-zinc-500" />
      <span className="shimmer-text">Working…</span>
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
  // Between the user's message and the first streamed output (or a finished step and the
  // next) nothing else shows that the agent is at work: say so.
  const lastBlock = blocks.at(-1);
  const pending =
    isBusy(session) &&
    session.status !== "waiting-approval" &&
    (lastBlock === undefined ||
      lastBlock.kind === "user" ||
      (lastBlock.kind === "assistant" && !lastBlock.streaming) ||
      lastBlock.kind === "turn-end" ||
      lastBlock.kind === "notice");
  const busy = isBusy(session);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // The first scroll after opening a session jumps; later ones glide.
  const jump = useRef(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The map itself is stable between changes; a filtered array from the selector would not be.
  const allPullRequests = useApp((s) => s.pullRequests);
  const pullRequests = useMemo(
    () => [...allPullRequests.values()].filter((p) => p.sessionId === session.id),
    [allPullRequests, session.id],
  );
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
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-zinc-100">{main ? bot.name : session.title}</span>
            {main ? <Badge>Orchestrator</Badge> : session.role === "reflection" ? <Badge tone="violet"><Sparkles className="size-2.5" />Reflection</Badge> : null}
            {session.status !== "idle" ? (
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-400">
                <StatusDot status={session.status} />
                {statusLabel[session.status]}
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
            {pullRequests.map((pr) => (
              <PullRequestChip key={pr.url} pr={pr} />
            ))}
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

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
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
            blocks.map((block, i) => (
              <Item key={block.key} item={block} respond={respond} live={busy && i === blocks.length - 1} sessionId={session.id} />
            ))
          )}
          {waitingFor ? <DownloadProgress model={waitingFor} /> : null}
          {pending ? loadingModel ? <LoadProgress model={loadingModel} /> : <WorkingRow /> : null}
        </div>
      </div>

      {session.role === "reflection" ? null : (
        <Composer key={session.id} session={session} botName={bot.name} modelLabel={modelLabel} waitingFor={waitingFor} />
      )}
    </section>
  );
}
