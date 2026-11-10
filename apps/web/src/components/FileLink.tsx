import type { FileReference } from "@apollo/client";
import type { SessionId } from "@apollo/contracts";
import { FolderOpen } from "lucide-react";
import { createContext, type MouseEvent, type ReactNode, useContext, useEffect, useState } from "react";

type OpenResult = { readonly ok: true; readonly revealed: boolean } | { readonly error: string };

/** What the desktop app's preload exposes (apps/desktop/src/preload.cts). */
interface DesktopBridge {
  openFile(request: { sessionId: string; path: string; reveal: boolean }): Promise<OpenResult>;
}

const desktop = (): DesktopBridge | null => (globalThis as { apolloDesktop?: DesktopBridge }).apolloDesktop ?? null;

/** The session whose messages are shown: their file links resolve against its folders. */
export const FileLinkSession = createContext<SessionId | null>(null);

export const localFileUrl = (sessionId: SessionId, path: string, download = false) =>
  `/api/files/${sessionId}/content?${new URLSearchParams({ path, ...(download ? { download: "1" } : {}) })}`;

const revealLabel = (globalThis.navigator?.platform ?? "").toLowerCase().startsWith("mac") ? "Show in Finder" : "Show in Explorer";

/**
 * A local file a message mentions. The desktop app opens it in its default app (or shows it
 * in Finder or Explorer); a browser opens it in a new tab through the server. Either way the
 * server checks it is inside the session's folder, its bot's workspace or a project folder.
 * Outside a session's messages it is shown as plain text.
 */
export function FileLink({ file, children }: { file: FileReference; children: ReactNode }) {
  const sessionId = useContext(FileLinkSession);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);
  if (!sessionId) return <>{children}</>;
  const bridge = desktop();
  const open = (event: MouseEvent, reveal: boolean) => {
    if (!bridge) return;
    event.preventDefault();
    event.stopPropagation();
    setError(null);
    bridge.openFile({ sessionId, path: file.path, reveal }).then(
      (result) => "error" in result && setError(result.error),
      () => setError("Could not open it."),
    );
  };
  return (
    <span className="group/file">
      <a
        href={localFileUrl(sessionId, file.path)}
        target="_blank"
        rel="noopener noreferrer"
        title={bridge ? `${file.path}\nClick to open · ⌥-click: ${revealLabel.toLowerCase()}` : file.path}
        onClick={(e) => open(e, e.altKey)}
      >
        {children}
      </a>
      {bridge ? (
        <button
          type="button"
          data-search-skip=""
          title={revealLabel}
          aria-label={`${revealLabel}: ${file.path}`}
          onClick={(e) => open(e, true)}
          className="ml-0.5 inline-flex size-4 items-center justify-center rounded align-[-2px] text-zinc-500 opacity-0 transition-opacity group-hover/file:opacity-100 hover:text-zinc-200 focus-visible:opacity-100"
        >
          <FolderOpen className="size-3" />
        </button>
      ) : null}
      {error ? (
        <span role="alert" data-search-skip="" className="ml-1.5 text-xs text-red-400">
          {error}
        </span>
      ) : null}
    </span>
  );
}
