import { codeLanguage, codePlainColor, highlightCode } from "@apollo/client";
import type { Bot, ChangesOverview, OverviewFile, PullRequest, SemanticFileDiff, SemanticSymbol, Session, SessionId } from "@apollo/contracts";
import {
  Braces,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  Box,
  FileCode2,
  FolderGit2,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Hash,
  Heading,
  Layers,
  Loader2,
  type LucideIcon,
  Sparkles,
  SquareFunction,
  Type,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { errorMessage, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";
import { Collapse, cx, EmptyState, Panel, Tooltip } from "./ui.tsx";

/**
 * What the agents changed, and their pull requests. The file lists, the grouping by
 * declaration and the diffs are computed by Apollo (deterministic); only the sparkle-marked
 * explanations come from the worker's model.
 */
export function ChangesPanel({
  session,
  bot,
  onClose,
  onOpenSession,
}: {
  session: Session;
  bot: Bot;
  onClose: () => void;
  onOpenSession: (id: SessionId) => void;
}) {
  // Refetch when the server says this bot's changes moved (a turn ended, a worker explained).
  const version = useApp((s) => s.changesVersion.get(bot.id) ?? 0);
  const [overview, setOverview] = useState<ChangesOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc((c) => c["changes.list"]({ sessionId: session.id }))
      .then((next) => !cancelled && (setOverview(next), setError(null)))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [session.id, version]);

  const fileCount = overview?.sessions.reduce((n, s) => n + s.repos.reduce((m, r) => m + r.files.length, 0), 0) ?? 0;
  const pullRequests = useSessionPullRequests(session);

  return (
    <Panel
      name="changes"
      width="wide"
      onClose={onClose}
      title={
        <>
          <GitCompareArrows className="size-4 shrink-0 text-zinc-400" />
          <span className="text-sm font-medium text-zinc-200">Changes</span>
          {fileCount > 0 ? (
            <span key={fileCount} className="animate-pop-in ml-1 rounded-md bg-zinc-800 px-1.5 py-px text-[10px] font-medium text-zinc-400 tabular-nums">
              {fileCount} {fileCount === 1 ? "file" : "files"}
            </span>
          ) : null}
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {error ? <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">{error}</div> : null}
        {overview === null && !error ? <PanelSkeleton /> : null}
        {overview && overview.sessions.length === 0 ? (
          <EmptyState icon={GitCompareArrows} title="No changes yet">
            Files the agents change in git repositories show up here after each turn, grouped by the functions and types
            they touch.
          </EmptyState>
        ) : null}
        {overview?.sessions.map((changes, i) => (
          <section key={changes.sessionId} className="animate-fade-up space-y-3" style={{ animationDelay: `${i * 40}ms` }}>
            {overview.sessions.length > 1 || changes.sessionId !== session.id ? (
              <button
                type="button"
                onClick={() => onOpenSession(changes.sessionId as SessionId)}
                className="group flex w-full items-center gap-2 text-left text-[11px] font-semibold tracking-wider text-zinc-500 uppercase hover:text-zinc-300"
              >
                <Layers className="size-3.5" />
                <span className="truncate">{changes.title}</span>
                <span className="h-px flex-1 bg-zinc-800/80 transition-colors group-hover:bg-zinc-700" />
              </button>
            ) : null}
            {changes.summaries.length > 0 ? <Summaries summaries={changes.summaries} /> : null}
            {changes.repos.map((repo) => (
              <RepoCard key={repo.repo} sessionId={changes.sessionId as SessionId} repo={repo} version={version} />
            ))}
          </section>
        ))}
        <PullRequests pullRequests={pullRequests} />
      </div>
    </Panel>
  );
}

// --- worker summaries ------------------------------------------------------------

const EXPLANATIONS_KEY = "apollo.changes.explanationsOpen";
const readExplanationsOpen = () => {
  try {
    return localStorage.getItem(EXPLANATIONS_KEY) !== "0";
  } catch {
    return true;
  }
};

/** The worker's explanations; folds to one line (remembered) from its header. */
function Summaries({ summaries }: { summaries: ReadonlyArray<{ text: string; at: number }> }) {
  const [open, setOpen] = useState(readExplanationsOpen);
  const [all, setAll] = useState(false);
  const [latest, ...older] = summaries;
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(EXPLANATIONS_KEY, open ? "0" : "1");
    } catch {}
  };
  return (
    <div className="rounded-xl border border-violet-500/20 bg-gradient-to-b from-violet-500/[0.07] to-transparent">
      <button type="button" onClick={toggle} aria-expanded={open} className="group flex w-full min-w-0 items-center gap-1.5 px-3 py-2.5 text-left">
        <Sparkles className="size-3 shrink-0 text-violet-300/90" />
        <span className="shrink-0 text-[10.5px] font-semibold tracking-wider text-violet-300/90 uppercase">Explained by the worker</span>
        {!open ? <span className="min-w-0 flex-1 truncate pl-1 text-xs text-zinc-400">{latest!.text}</span> : <span className="flex-1" />}
        <ChevronRight className={cx("size-3.5 shrink-0 text-violet-300/60 transition-transform duration-200 group-hover:text-violet-200", open && "rotate-90")} />
      </button>
      <Collapse open={open}>
        <div className="px-3 pb-3">
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-200">{latest!.text}</p>
          {older.length > 0 ? (
            <>
              <Collapse open={all}>
                <div className="mt-2 space-y-2 border-t border-violet-500/10 pt-2">
                  {older.map((s) => (
                    <p key={s.at} className="text-xs leading-relaxed whitespace-pre-wrap text-zinc-400">
                      <span className="mr-1.5 text-[10px] text-zinc-600 tabular-nums">
                        {new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      {s.text}
                    </p>
                  ))}
                </div>
              </Collapse>
              <button type="button" onClick={() => setAll(!all)} className="mt-1.5 text-[11px] text-violet-300/70 hover:text-violet-200">
                {all ? "Show less" : `${older.length} earlier ${older.length === 1 ? "explanation" : "explanations"}`}
              </button>
            </>
          ) : null}
        </div>
      </Collapse>
    </div>
  );
}

// --- repositories and files ------------------------------------------------------------

const STATUS: Record<OverviewFile["status"], { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/25", label: "Added" },
  modified: { letter: "M", className: "bg-amber-500/15 text-amber-300 ring-amber-500/25", label: "Modified" },
  deleted: { letter: "D", className: "bg-red-500/15 text-red-300 ring-red-500/25", label: "Deleted" },
  renamed: { letter: "R", className: "bg-sky-500/15 text-sky-300 ring-sky-500/25", label: "Renamed" },
};

function RepoCard({
  sessionId,
  repo,
  version,
}: {
  sessionId: SessionId;
  repo: { repo: string; name: string; files: ReadonlyArray<OverviewFile> };
  version: number;
}) {
  const [open, setOpen] = useState(true);
  const additions = repo.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = repo.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800/90 bg-zinc-900/30">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-zinc-900/60"
      >
        <FolderGit2 className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} />
        <Tooltip align="start" content={<span className="font-mono">{repo.repo}</span>}>
          <span className="truncate text-[13px] font-medium text-zinc-100">{repo.name}</span>
        </Tooltip>
        <span className="text-[11px] text-zinc-500 tabular-nums">
          {repo.files.length} {repo.files.length === 1 ? "file" : "files"}
        </span>
        <span className="flex-1" />
        <Counts additions={additions} deletions={deletions} />
        <ChevronRight className={cx("size-3.5 shrink-0 text-zinc-500 transition-transform duration-200", open && "rotate-90")} />
      </button>
      <Collapse open={open}>
        <div className="border-t border-zinc-800/80">
          {repo.files.map((file, i) => (
            <FileRow key={file.path} sessionId={sessionId} repo={repo.repo} file={file} version={version} index={i} />
          ))}
        </div>
      </Collapse>
    </div>
  );
}

function Counts({ additions, deletions, binary = false }: { additions: number; deletions: number; binary?: boolean }) {
  if (binary) return <span className="text-[10.5px] text-zinc-500">binary</span>;
  const total = additions + deletions;
  const greens = total === 0 ? 0 : Math.round((additions / total) * 5);
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
      <span className="text-emerald-400">+{additions}</span>
      <span className="text-red-400">−{deletions}</span>
      <span className="flex gap-px">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className={cx("size-1.5 rounded-[1px]", total === 0 ? "bg-zinc-700" : i < greens ? "bg-emerald-500/80" : "bg-red-500/70")} />
        ))}
      </span>
    </span>
  );
}

function FileRow({
  sessionId,
  repo,
  file,
  version,
  index,
}: {
  sessionId: SessionId;
  repo: string;
  file: OverviewFile;
  version: number;
  index: number;
}) {
  const [open, setOpen] = useState(false);
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = file.path.slice(slash + 1);
  const status = STATUS[file.status];
  return (
    <div className={cx("animate-fade-up border-b border-zinc-800/50 last:border-b-0", open && "bg-zinc-950/40")} style={{ animationDelay: `${Math.min(index, 12) * 18}ms` }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-zinc-800/30"
      >
        <span title={status.label} className={cx("flex size-4.5 shrink-0 items-center justify-center rounded text-[9.5px] font-bold ring-1 ring-inset", status.className)}>
          {status.letter}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
          <span className="text-zinc-500">{dir}</span>
          <span className={cx("text-zinc-200", file.status === "deleted" && "text-zinc-400 line-through decoration-zinc-600")}>{name}</span>
          {file.oldPath ? <span className="text-zinc-600"> ← {file.oldPath}</span> : null}
        </span>
        {file.note ? <Sparkles className="size-3 shrink-0 text-violet-300/80" /> : null}
        <Counts additions={file.additions ?? 0} deletions={file.deletions ?? 0} binary={file.additions === null} />
        <ChevronRight className={cx("size-3.5 shrink-0 text-zinc-600 transition-transform duration-200 group-hover:text-zinc-400", open && "rotate-90")} />
      </button>
      {!open && file.note ? <p className="-mt-1 truncate px-3 pb-2 pl-10 text-[11.5px] text-zinc-500 italic">{file.note}</p> : null}
      <Collapse open={open}>{open ? <FileDiff sessionId={sessionId} repo={repo} path={file.path} version={version} /> : null}</Collapse>
    </div>
  );
}

// --- the semantic diff of one file ----------------------------------------------------------

function FileDiff({ sessionId, repo, path, version }: { sessionId: SessionId; repo: string; path: string; version: number }) {
  const [diff, setDiff] = useState<SemanticFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    rpc((c) => c["changes.file"]({ sessionId, repo, path }))
      .then((next) => !cancelled && (setDiff(next), setError(null)))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [sessionId, repo, path, version]);

  if (error) return <div className="px-3 pb-3 pl-10 text-xs text-red-300">{error}</div>;
  if (!diff) {
    return (
      <div className="flex items-center gap-2 px-3 pb-3 pl-10 text-xs">
        <Loader2 className="size-3 animate-spin text-zinc-500" />
        <span className="shimmer-text">Reading the diff…</span>
      </div>
    );
  }
  const language = codeLanguage(path.split(".").pop() ?? null);
  return (
    <div className="animate-fade-up space-y-2 px-3 pb-3 pl-10">
      {diff.note ? <Note>{diff.note}</Note> : null}
      {diff.omitted ? <p className="text-xs text-zinc-500 italic">{diff.omitted}</p> : null}
      <div className="space-y-1">
        {diff.symbols.map((symbol, i) => (
          <SymbolRow key={symbol.name} symbol={symbol} language={language} index={i} single={diff.symbols.length === 1} />
        ))}
      </div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg border border-violet-500/15 bg-violet-500/[0.06] px-2.5 py-2 text-[12px] leading-relaxed text-zinc-300">
      <Sparkles className="mt-0.5 size-3 shrink-0 text-violet-300/90" />
      <span className="min-w-0 whitespace-pre-wrap">{children}</span>
    </div>
  );
}

const KIND: Record<SemanticSymbol["kind"], { icon: LucideIcon; className: string; label: string }> = {
  function: { icon: SquareFunction, className: "text-sky-300", label: "Function" },
  method: { icon: SquareFunction, className: "text-cyan-300", label: "Method" },
  class: { icon: Box, className: "text-amber-300", label: "Class" },
  type: { icon: Type, className: "text-teal-300", label: "Type" },
  constant: { icon: Hash, className: "text-fuchsia-300", label: "Constant" },
  section: { icon: Heading, className: "text-violet-300", label: "Section" },
  module: { icon: Braces, className: "text-zinc-400", label: "Module scope" },
};

const CHANGE: Record<SemanticSymbol["change"], { label: string; className: string }> = {
  added: { label: "added", className: "bg-emerald-500/15 text-emerald-300" },
  removed: { label: "removed", className: "bg-red-500/15 text-red-300" },
  modified: { label: "changed", className: "bg-zinc-800 text-zinc-400" },
};

function SymbolRow({ symbol, language, index, single }: { symbol: SemanticSymbol; language: string | null; index: number; single: boolean }) {
  const [open, setOpen] = useState(single);
  const kind = KIND[symbol.kind];
  const change = CHANGE[symbol.change];
  return (
    <div className="animate-fade-up overflow-hidden rounded-lg border border-zinc-800/70 bg-zinc-900/40" style={{ animationDelay: `${Math.min(index, 10) * 25}ms` }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-zinc-800/40"
      >
        <kind.icon className={cx("size-3.5 shrink-0", kind.className)} strokeWidth={1.75} aria-label={kind.label} />
        <span className={cx("min-w-0 truncate font-mono text-[12px]", symbol.change === "removed" ? "text-zinc-400 line-through decoration-zinc-600" : "text-zinc-100")}>
          {symbol.name}
        </span>
        <span className={cx("shrink-0 rounded px-1.5 py-px text-[9.5px] font-semibold tracking-wide uppercase", change.className)}>{change.label}</span>
        <span className="flex-1" />
        {symbol.note ? <Sparkles className="size-3 shrink-0 text-violet-300/80" /> : null}
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
          <span className="text-emerald-400">+{symbol.additions}</span> <span className="text-red-400">−{symbol.deletions}</span>
        </span>
        <ChevronRight className={cx("size-3 shrink-0 text-zinc-600 transition-transform duration-200", open && "rotate-90")} />
      </button>
      {symbol.note ? <div className="px-2.5 pb-2">{open ? <Note>{symbol.note}</Note> : <p className="truncate pl-5.5 text-[11.5px] text-zinc-500 italic">{symbol.note}</p>}</div> : null}
      <Collapse open={open}>
        <div className="border-t border-zinc-800/70">
          {symbol.hunks.map((hunk, i) => (
            <HunkView key={i} hunk={hunk} language={language} first={i === 0} />
          ))}
        </div>
      </Collapse>
    </div>
  );
}

const LINE = {
  add: { row: "bg-emerald-500/[0.09]", gutter: "text-emerald-500/70", sign: "+" },
  del: { row: "bg-red-500/[0.09]", gutter: "text-red-500/70", sign: "−" },
  ctx: { row: "", gutter: "text-zinc-700", sign: " " },
} as const;

function HunkView({ hunk, language, first }: { hunk: SemanticSymbol["hunks"][number]; language: string | null; first: boolean }) {
  // Highlighting the hunk as one piece keeps strings and comments that span lines right.
  const spans = useMemo(() => highlightCode(hunk.lines.map((l) => l.text).join("\n"), language), [hunk, language]);
  return (
    <div className={cx("overflow-x-auto font-mono text-[11.5px] leading-[1.55]", !first && "border-t border-dashed border-zinc-800")} style={{ color: codePlainColor }}>
      <table className="w-full border-collapse">
        <tbody>
          {hunk.lines.map((line, i) => {
            const style = LINE[line.kind];
            return (
              <tr key={i} className={style.row}>
                <td className={cx("w-9 pr-1.5 pl-2 text-right align-top select-none tabular-nums", style.gutter)}>{line.oldNo ?? ""}</td>
                <td className={cx("w-9 pr-1.5 text-right align-top select-none tabular-nums", style.gutter)}>{line.newNo ?? ""}</td>
                <td className={cx("w-4 text-center align-top select-none", style.gutter)}>{style.sign}</td>
                <td className="pr-3 whitespace-pre">
                  {(spans[i] ?? [{ text: line.text }]).map((span, j) =>
                    span.color || span.fontStyle ? (
                      <span key={j} style={{ color: span.color, fontStyle: span.fontStyle }}>
                        {span.text}
                      </span>
                    ) : (
                      <span key={j}>{span.text}</span>
                    ),
                  )}
                  {line.text === "" ? " " : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- pull requests ----------------------------------------------------------------------

/** The session's pull requests; an orchestrator's include its workers'. */
const useSessionPullRequests = (session: Session) => {
  const all = useApp((s) => s.pullRequests);
  const sessions = useApp((s) => s.sessions);
  return useMemo(() => {
    const ids = new Set(
      session.role === "main" ? [...sessions.values()].filter((s) => s.botId === session.botId).map((s) => s.id) : [session.id],
    );
    // One row per URL (a PR can be linked from several sessions), newest first.
    const byUrl = new Map<string, PullRequest>();
    for (const pr of all.values()) if (ids.has(pr.sessionId) && (byUrl.get(pr.url)?.updatedAt ?? 0) < pr.updatedAt) byUrl.set(pr.url, pr);
    return [...byUrl.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [all, sessions, session]);
};

function PullRequests({ pullRequests }: { pullRequests: ReadonlyArray<PullRequest> }) {
  const [showMerged, setShowMerged] = useState(false);
  const active = pullRequests.filter((pr) => pr.state === "open" || pr.state === "draft");
  const done = pullRequests.filter((pr) => pr.state === "merged" || pr.state === "closed");
  if (pullRequests.length === 0) return null;
  return (
    <section className="animate-fade-up space-y-2">
      <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
        <GitPullRequest className="size-3.5" /> Pull requests
        <span className="h-px flex-1 bg-zinc-800/80" />
      </div>
      {active.length === 0 ? <p className="text-xs text-zinc-500">No open pull requests.</p> : null}
      <div className="space-y-1.5">
        {active.map((pr, i) => (
          <PullRequestRow key={pr.url} pr={pr} index={i} />
        ))}
      </div>
      {done.length > 0 ? (
        <div>
          <button
            type="button"
            onClick={() => setShowMerged(!showMerged)}
            aria-expanded={showMerged}
            className="group flex items-center gap-1.5 py-1 text-xs text-zinc-500 hover:text-zinc-300"
          >
            <ChevronRight className={cx("size-3.5 transition-transform duration-200", showMerged && "rotate-90")} />
            <GitMerge className="size-3.5 text-violet-300/70" /> Merged
            <span className="rounded bg-zinc-800 px-1.5 text-[10px] tabular-nums">{done.length}</span>
          </button>
          <Collapse open={showMerged}>
            <div className="space-y-1.5 pt-1">
              {done.map((pr, i) => (
                <PullRequestRow key={pr.url} pr={pr} index={i} />
              ))}
            </div>
          </Collapse>
        </div>
      ) : null}
    </section>
  );
}

const CHECKS: Record<PullRequest["checks"], { icon: LucideIcon; label: string; className: string }> = {
  none: { icon: CircleDot, label: "No checks", className: "text-zinc-500" },
  pending: { icon: Clock, label: "Checks running", className: "text-amber-300" },
  passing: { icon: CircleCheck, label: "Checks passed", className: "text-emerald-400" },
  failing: { icon: CircleX, label: "Checks failed", className: "text-red-400" },
};

function PullRequestRow({ pr, index }: { pr: PullRequest; index: number }) {
  const done = pr.state === "merged" || pr.state === "closed";
  const Icon = pr.state === "merged" ? GitMerge : pr.state === "draft" ? GitPullRequestDraft : GitPullRequest;
  const checks = CHECKS[pr.checks];
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      className="animate-fade-up group flex min-w-0 items-center gap-2.5 rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-3 py-2 transition-all hover:-translate-y-px hover:border-zinc-700 hover:bg-zinc-900/70"
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
    >
      <Icon
        className={cx(
          "size-4 shrink-0",
          pr.state === "merged" ? "text-violet-300" : pr.state === "closed" ? "text-red-300/80" : pr.state === "draft" ? "text-zinc-400" : "text-emerald-400",
        )}
        strokeWidth={1.75}
      />
      <span className="min-w-0 flex-1">
        <span className={cx("block truncate text-[13px]", done ? "text-zinc-400" : "text-zinc-100")}>{pr.title}</span>
        <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
          <FileCode2 className="size-3" />
          {pr.repo}#{pr.number}
          {pr.state === "closed" ? <span className="text-red-300/80">· closed</span> : null}
          {pr.state === "draft" ? <span>· draft</span> : null}
          {pr.review ? <span className={pr.review === "approved" ? "text-emerald-400" : pr.review === "changes_requested" ? "text-amber-300" : ""}>· {pr.review.replace("_", " ")}</span> : null}
        </span>
      </span>
      {!done ? (
        <span title={checks.label} className={cx("flex shrink-0 items-center gap-1 text-[11px]", checks.className)}>
          {pr.checks === "pending" ? <Loader2 className="size-3.5 animate-spin" /> : <checks.icon className="size-3.5" />}
        </span>
      ) : null}
    </a>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1].map((i) => (
        <div key={i} className="animate-fade-up space-y-2 rounded-xl border border-zinc-800/80 p-3" style={{ animationDelay: `${i * 60}ms` }}>
          <div className="h-3 w-32 animate-pulse rounded bg-zinc-800" />
          {[0, 1, 2].map((j) => (
            <div key={j} className="h-2.5 animate-pulse rounded bg-zinc-800/70" style={{ width: `${80 - j * 15}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}
