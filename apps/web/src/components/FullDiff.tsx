import type { ChangeReport, RepoChanges, SessionId } from "@apollo/contracts";
import { ChevronRight, FolderGit2, GitCommitHorizontal, GitCompareArrows, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Counts, FileRow } from "./ChangesPanel.tsx";
import { Collapse, cx, Tooltip } from "./ui.tsx";

/**
 * The full semantic diff of a repository the user asked for (`apollo_semantic_diff`): every
 * file that differs from its baseline, whichever turn changed it, as of when it was asked.
 * Files open as semantic diffs, like the Changes panel's; only the ✦ notes come from workers.
 */
export function FullDiff({
  sessionId,
  seq,
  repo,
  report,
  at,
  onClear,
}: {
  sessionId: SessionId;
  seq: number;
  repo: RepoChanges;
  report: ChangeReport;
  at: number | undefined;
  /** Clears the card from the conversation (every client); undone from the line left in its place. */
  onClear: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [commitsOpen, setCommitsOpen] = useState(false);
  const notes = useMemo(() => new Map(report.notes.map((n) => [n.path, n.text])), [report.notes]);
  // Over every changed file, listed or not, like the file count.
  const { additions, deletions } = report;
  const total = repo.files.length + report.moreFiles;
  const base = report.base.commit ? `${report.base.ref} @ ${report.base.commit.slice(0, 7)}` : report.base.ref;
  return (
    <div className="animate-fade-up group overflow-hidden rounded-xl border border-zinc-800/90 bg-zinc-900/30">
      <div className="flex min-w-0 items-center">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 py-2.5 pl-3 pr-2 text-left transition-colors hover:bg-zinc-900/60"
        >
          <GitCompareArrows className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} />
          <span className="shrink-0 text-[13px] font-medium text-zinc-100">Full diff</span>
          <Tooltip align="start" content={<span className="font-mono">{repo.repo}</span>}>
            <span className="flex min-w-0 items-center gap-1 truncate text-[13px] text-zinc-300">
              <FolderGit2 className="size-3.5 shrink-0 text-zinc-500" strokeWidth={1.75} />
              {repo.name}
            </span>
          </Tooltip>
          <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">vs {base}</span>
          <span className="flex-1" />
          <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">
            {total} {total === 1 ? "file" : "files"}
          </span>
          <Counts additions={additions} deletions={deletions} />
          <ChevronRight className={cx("size-3.5 shrink-0 text-zinc-500 transition-transform duration-200", open && "rotate-90")} />
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
        <div className="border-t border-zinc-800/80">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[11.5px] text-zinc-500">
            {report.head.branch ? <span className="font-mono text-zinc-400">{report.head.branch}</span> : null}
            {report.commitCount > 0 ? (
              <button type="button" onClick={() => setCommitsOpen(!commitsOpen)} aria-expanded={commitsOpen} className="flex items-center gap-1 hover:text-zinc-300">
                <GitCommitHorizontal className="size-3.5" />
                {report.commitCount} {report.commitCount === 1 ? "commit" : "commits"} since the base
                <ChevronRight className={cx("size-3 transition-transform duration-200", commitsOpen && "rotate-90")} />
              </button>
            ) : (
              <span>No commits since the base</span>
            )}
            {report.uncommitted ? <span className="text-amber-300/80">+ uncommitted changes</span> : null}
            <span className="flex-1" />
            {at ? <span>as of {new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}
          </div>
          <Collapse open={commitsOpen}>
            <ul className="space-y-0.5 px-3 pb-2">
              {report.commits.map((c) => (
                <li key={c.sha} className="flex min-w-0 gap-2 text-[11.5px]">
                  <span className="shrink-0 font-mono text-zinc-500">{c.sha}</span>
                  <span className="min-w-0 truncate text-zinc-300">{c.subject}</span>
                </li>
              ))}
              {report.commitCount > report.commits.length ? (
                <li className="text-[11px] text-zinc-500">and {report.commitCount - report.commits.length} older</li>
              ) : null}
            </ul>
          </Collapse>
          <div className="border-t border-zinc-800/80">
            {repo.files.length === 0 ? <p className="px-3 py-2 text-xs text-zinc-500">Nothing differs from the base.</p> : null}
            {repo.files.map((file, i) => (
              <FileRow
                key={file.path}
                sessionId={sessionId}
                repo={repo.repo}
                file={{ ...file, note: notes.get(file.path) ?? null }}
                version={0}
                index={i}
                reportSeq={seq}
              />
            ))}
            {report.moreFiles > 0 ? (
              <p className="px-3 py-2 text-[11.5px] text-zinc-500 italic">
                and {report.moreFiles} more {report.moreFiles === 1 ? "file" : "files"}, not listed: ask for a diff against a closer base
              </p>
            ) : null}
          </div>
        </div>
      </Collapse>
    </div>
  );
}
