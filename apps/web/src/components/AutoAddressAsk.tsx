import { autoAddressAsks, prSessionIds } from "@apollo/client";
import type { PullRequest, Session, SessionId } from "@apollo/contracts";
import { GitPullRequest } from "lucide-react";
import { useMemo, useState } from "react";
import { errorMessage, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";

/**
 * Above the message box: PRs the agents linked whose user has not said yet whether the agent
 * should address their review comments. Auto-address starts off; nothing waits for this.
 */
export function AutoAddressAsk({ session }: { session: Session }) {
  const reviews = useApp((s) => s.pullRequestReviews);
  const pullRequests = useApp((s) => s.pullRequests);
  const sessions = useApp((s) => s.sessions);
  const asks = useMemo(
    () => autoAddressAsks(reviews, pullRequests, prSessionIds(session, sessions.values())),
    [reviews, pullRequests, sessions, session],
  );
  if (asks.length === 0) return null;
  return (
    <div className="mb-2 space-y-1.5">
      {asks.map((ask) => (
        <AskRow key={`${ask.sessionId} ${ask.url}`} sessionId={ask.sessionId} pr={ask.pr} />
      ))}
    </div>
  );
}

function AskRow({ sessionId, pr }: { sessionId: SessionId; pr: PullRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (enabled: boolean) => {
    setBusy(true);
    setError(null);
    rpc((c) => c["pullRequests.setAutoAddress"]({ sessionId, url: pr.url, enabled })).catch((e: unknown) => {
      setBusy(false);
      setError(errorMessage(e));
    });
  };
  return (
    <div className="animate-pop-in flex items-center gap-3 rounded-xl border border-sky-500/25 bg-sky-500/5 px-3 py-2">
      <GitPullRequest className="size-4 shrink-0 text-sky-300" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-sky-100">
          Address review comments on{" "}
          <a href={pr.url} target="_blank" rel="noreferrer" className="hover:underline">
            {pr.repo}#{pr.number}
          </a>
          ?
        </div>
        <div className="truncate text-[11px] text-zinc-400">
          {error ?? "The agent would fix or answer new comments, push, and reply on GitHub under your account."}
        </div>
      </div>
      <button
        type="button"
        onClick={() => answer(false)}
        disabled={busy}
        className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
      >
        Not now
      </button>
      <button
        type="button"
        onClick={() => answer(true)}
        disabled={busy}
        className="shrink-0 rounded-lg bg-sky-500/20 px-2.5 py-1 text-[11px] font-medium text-sky-100 transition-colors hover:bg-sky-500/30 disabled:opacity-50"
      >
        Turn on
      </button>
    </div>
  );
}
