import type { ApprovalDecision, Bot, InputResponse, Session } from "@apollo/contracts";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { errorMessage, rpc } from "../rpc.ts";
import { type TranscriptItem, useTranscript } from "../transcript.ts";
import { InputRequestItem } from "./InputRequest.tsx";
import { Button, cx, ProviderBadge, StatusDot } from "./ui.tsx";

function ToolItem({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const pending = item.output === null;
  const name = item.name.replace(/^mcp__apollo__/, "");
  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/40 text-xs">
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen(!open)}>
        <span
          className={cx(
            "size-1.5 shrink-0 rounded-full",
            pending ? "animate-pulse bg-amber-400" : item.isError ? "bg-red-500" : "bg-emerald-500",
          )}
        />
        <span className="shrink-0 font-mono text-zinc-300">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-zinc-500">{item.summary}</span>
        <span className="text-zinc-600">{open ? "▾" : "▸"}</span>
      </button>
      {open && item.output ? (
        <pre className="max-h-72 overflow-auto border-t border-zinc-800/80 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-zinc-400">
          {item.output}
        </pre>
      ) : null}
    </div>
  );
}

function ApprovalItem({
  item,
  onRespond,
}: {
  item: Extract<TranscriptItem, { kind: "approval" }>;
  onRespond: (requestId: string, decision: ApprovalDecision) => void;
}) {
  return (
    <div className="rounded-lg border border-amber-700/40 bg-amber-950/20 p-3 text-sm">
      <div className="font-medium text-amber-200">{item.title}</div>
      <pre className="mt-1.5 font-mono text-xs whitespace-pre-wrap text-zinc-300">{item.detail}</pre>
      {item.decision === null ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="primary" onClick={() => onRespond(item.requestId, "accept")}>
            Allow
          </Button>
          <Button size="sm" onClick={() => onRespond(item.requestId, "accept-for-session")}>
            Allow for session
          </Button>
          <Button size="sm" variant="danger" onClick={() => onRespond(item.requestId, "decline")}>
            Decline
          </Button>
        </div>
      ) : (
        <div className="mt-2 text-xs text-zinc-500">{item.decision === "decline" ? "Declined" : "Allowed"}</div>
      )}
    </div>
  );
}

interface Responders {
  readonly approval: (requestId: string, decision: ApprovalDecision) => void;
  readonly input: (requestId: string, response: InputResponse) => void;
}

function Item({ item, respond }: { item: TranscriptItem; respond: Responders }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div
            className={cx(
              "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap",
              item.author === "user" ? "bg-zinc-800 text-zinc-100" : "border border-zinc-800 bg-zinc-900/50 text-zinc-400",
            )}
          >
            {item.author !== "user" ? (
              <div className="mb-1 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">
                {item.author === "bot" ? "From orchestrator" : "Apollo"}
              </div>
            ) : null}
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="markdown text-sm leading-relaxed text-zinc-200">
          <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
          {item.streaming ? <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-zinc-400 align-middle" /> : null}
        </div>
      );
    case "reasoning":
      return (
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer select-none">Thinking</summary>
          <div className="mt-1 border-l border-zinc-800 pl-3 whitespace-pre-wrap">{item.text}</div>
        </details>
      );
    case "tool":
      return <ToolItem item={item} />;
    case "approval":
      return <ApprovalItem item={item} onRespond={respond.approval} />;
    case "input":
      return <InputRequestItem item={item} onRespond={respond.input} />;
    case "notice":
      return (
        <div className={cx("text-xs", item.level === "error" ? "text-red-400" : "text-zinc-500")}>{item.message}</div>
      );
    case "turn-end":
      return (
        <div className="text-xs text-zinc-500">
          Turn {item.outcome}
          {item.error ? `: ${item.error}` : ""}
        </div>
      );
  }
}

function Composer({ session, disabled }: { session: Session; disabled: boolean }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = session.status === "running" || session.status === "waiting-approval" || session.status === "starting";

  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    setError(null);
    rpc((c) => c["sessions.send"]({ sessionId: session.id, text: value })).catch((e) => {
      setError(errorMessage(e));
      setText(value);
    });
  };

  return (
    <div className="border-t border-zinc-800/80 p-3">
      {error ? <div className="mb-2 text-xs text-red-400">{error}</div> : null}
      <div className="flex items-end gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-2 focus-within:border-zinc-600">
        <textarea
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          placeholder={
            session.role === "main"
              ? "Message the bot… it can delegate to worker sessions"
              : busy
                ? "Send a follow-up (folded into the running turn)…"
                : "Message this session…"
          }
          className="max-h-60 min-h-8 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
        />
        {busy ? (
          <Button size="sm" onClick={() => rpc((c) => c["sessions.interrupt"]({ sessionId: session.id }))}>
            Stop
          </Button>
        ) : null}
        <Button size="sm" variant="primary" disabled={!text.trim() || disabled} onClick={send}>
          Send
        </Button>
      </div>
    </div>
  );
}

export function SessionView({
  session,
  bot,
  onShowKnowledge,
}: {
  session: Session;
  bot: Bot;
  onShowKnowledge: () => void;
}) {
  const items = useTranscript(session.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const act = (f: Parameters<typeof rpc>[0]) => {
    setActionError(null);
    rpc(f).catch((e) => setActionError(errorMessage(e)));
  };

  const respond: Responders = {
    approval: (requestId, decision) =>
      act((c) => c["sessions.respondApproval"]({ sessionId: session.id, requestId, decision })),
    input: (requestId, response) =>
      act((c) => c["sessions.respondInput"]({ sessionId: session.id, requestId, response })),
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800/80 px-4">
        <StatusDot status={session.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-100">
            {session.role === "main" ? `${bot.name} · orchestrator` : session.title}
          </div>
          <div className="truncate font-mono text-[11px] text-zinc-500">{session.cwd}</div>
        </div>
        <ProviderBadge provider={session.provider} model={session.model} />
        {actionError ? <span className="max-w-60 truncate text-xs text-red-400">{actionError}</span> : null}
        {session.role !== "reflection" ? (
          <Button
            size="sm"
            variant="ghost"
            title="Extract memories and skill proposals from this session"
            disabled={session.completedTurns === 0}
            onClick={() => act((c) => c["sessions.reflect"]({ sessionId: session.id }))}
          >
            Reflect
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onShowKnowledge}>
          Knowledge
        </Button>
        {session.role !== "main" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (confirm(`Delete session "${session.title}"?`)) {
                act((c) => c["sessions.delete"]({ sessionId: session.id }));
              }
            }}
          >
            Delete
          </Button>
        ) : null}
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="mx-auto max-w-3xl space-y-3 px-4 py-6">
          {items.length === 0 ? (
            <div className="py-20 text-center text-sm text-zinc-500">
              {session.role === "main"
                ? `Talk to ${bot.name}. It can spawn ${bot.defaultWorker.provider} or other workers and remembers what it learns.`
                : "No messages yet."}
            </div>
          ) : (
            items.map((item) => <Item key={item.key} item={item} respond={respond} />)
          )}
        </div>
      </div>

      {session.role === "reflection" ? null : <Composer session={session} disabled={false} />}
    </section>
  );
}
