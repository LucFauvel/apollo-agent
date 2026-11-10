import { useBrowserFocus } from "./browserFocus.ts";
import { showApp, showNotification, watchSeen, watchTurns } from "./turnNotifications.ts";
import type { Bot, SessionId } from "@apollo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { BotSettingsDialog, NewBotDialog, NewSessionDialog } from "./components/Dialogs.tsx";
import { BrowserPanel } from "./components/BrowserPanel.tsx";
import { ChangesPanel } from "./components/ChangesPanel.tsx";
import { DevicesDialog } from "./components/DevicesDialog.tsx";
import { LocalModelsDialog } from "./components/LocalModelsDialog.tsx";
import { ProvidersDialog } from "./components/ProvidersDialog.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { KnowledgePanel } from "./components/KnowledgePanel.tsx";
import { SchedulesPanel } from "./components/SchedulesPanel.tsx";
import { type PanelKind, SessionView } from "./components/SessionView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { ClaudeLogo, CodexLogo, LlamaLogo } from "./components/icons.tsx";
import { Button } from "./components/ui.tsx";
import { Plus } from "lucide-react";
import { firstBot as firstBotOf, onNotify, startSync, useApp } from "./store.ts";
import { useAvatarImages } from "./avatarImages.ts";

/** Shows server notifications (scheduled results, failures) on the desktop; clicking opens the session. */
const useDesktopNotifications = (open: (id: SessionId) => void, selected: () => SessionId | null) =>
  useEffect(
    () =>
      onNotify((notice) => {
        // The desktop app shows these itself (see apolloOpenSession below).
        if (/Electron\//.test(navigator.userAgent)) return;
        // Session events (finished turns, approvals): watchTurns shows them, unless the user is looking.
        if (notice.pushed) return;
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        // Not for the conversation the user is looking at.
        if (notice.sessionId && document.hasFocus() && selected() === notice.sessionId) return;
        showNotification(notice.botId, notice.title, { body: notice.body }, () => {
          showApp();
          if (notice.sessionId) open(notice.sessionId);
        });
      }),
    [open, selected],
  );

export function App() {
  useEffect(() => startSync(), []);
  // Bot avatars as images for the phone's notifications.
  useAvatarImages(useApp((s) => s.bots));

  const [selectedId, setSelectedId] = useState<SessionId | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "bot" } | { kind: "session"; bot: Bot } | { kind: "botSettings"; bot: Bot } | { kind: "devices" } | { kind: "providers" } | { kind: "localModels" } | { kind: "settings" } | null
  >(null);
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const togglePanel = (next: PanelKind) => setPanel((current) => (current === next ? null : next));
  // An agent handed the browser over and the user asked to see the tab.
  const browserFocus = useBrowserFocus();
  useEffect(() => {
    if (browserFocus) setPanel("browser");
  }, [browserFocus]);
  // Notifications compare against the open session; read it through a ref.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const currentSelected = useCallback(() => selectedRef.current, []);
  useDesktopNotifications(setSelectedId, currentSelected);
  // The desktop app shows notifications itself (from the server, even with the window
  // closed) and opens a session through this hook; a plain browser tab does its own.
  useEffect(() => {
    (window as Window & { apolloOpenSession?: (id: string) => void }).apolloOpenSession = (id) => setSelectedId(id as SessionId);
    if (/Electron\//.test(navigator.userAgent)) return;
    return watchTurns(() => selectedRef.current, setSelectedId);
  }, []);

  const session = useApp((s) => (selectedId ? s.sessions.get(selectedId) : undefined));
  // Seeing one of a bot's chats dismisses its notifications, here and on the phone.
  const seenBotId = session?.botId ?? null;
  const seenBotRef = useRef(seenBotId);
  seenBotRef.current = seenBotId;
  const seenRef = useRef<ReturnType<typeof watchSeen> | null>(null);
  useEffect(() => {
    const watcher = watchSeen(() => seenBotRef.current);
    seenRef.current = watcher;
    return () => {
      watcher.stop();
      seenRef.current = null;
    };
  }, []);
  useEffect(() => seenRef.current?.check(), [selectedId, seenBotId]);
  const bot = useApp((s) => (session ? s.bots.get(session.botId) : undefined));
  const firstBot = useApp(firstBotOf);

  // Select the first bot's orchestrator once state arrives, and recover from deletions.
  useEffect(() => {
    if (!session && firstBot) setSelectedId(firstBot.mainSessionId);
  }, [session, firstBot]);

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-200">
      <Sidebar
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNewBot={() => setDialog({ kind: "bot" })}
        onNewSession={(b) => setDialog({ kind: "session", bot: b })}
        onBotSettings={(b) => setDialog({ kind: "botSettings", bot: b })}
        onDevices={() => setDialog({ kind: "devices" })}
        onProviders={() => setDialog({ kind: "providers" })}
        onSettings={() => setDialog({ kind: "settings" })}
      />
      {session && bot ? (
        <SessionView session={session} bot={bot} panel={panel} onTogglePanel={togglePanel} />
      ) : (
        <main className="relative flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div className="app-drag absolute inset-x-0 top-0 h-12" />
          <div className="flex items-center gap-3">
            {[ClaudeLogo, CodexLogo, LlamaLogo].map((Logo, i) => (
              <span key={i} className="flex size-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
                <Logo size={24} />
              </span>
            ))}
          </div>
          <div className="text-xl font-semibold tracking-tight text-zinc-100">Welcome to Apollo</div>
          <p className="max-w-sm text-sm leading-relaxed text-zinc-500">
            Bots orchestrate Claude Code, Codex and local llama.cpp sessions, and share memory and skills across all of
            them.
          </p>
          <Button variant="primary" onClick={() => setDialog({ kind: "bot" })}>
            <Plus /> Create a bot
          </Button>
        </main>
      )}
      {panel === "changes" && bot && session ? (
        <ChangesPanel session={session} bot={bot} onClose={() => setPanel(null)} onOpenSession={setSelectedId} />
      ) : null}
      {panel === "browser" && bot ? <BrowserPanel bot={bot} onClose={() => setPanel(null)} /> : null}
      {panel === "knowledge" && bot ? <KnowledgePanel bot={bot} onClose={() => setPanel(null)} /> : null}
      {panel === "schedules" && bot ? (
        <SchedulesPanel bot={bot} onClose={() => setPanel(null)} onOpenSession={setSelectedId} />
      ) : null}

      {dialog?.kind === "bot" ? (
        <NewBotDialog
          onClose={() => setDialog(null)}
          onCreated={(b) => {
            setDialog(null);
            setSelectedId(b.mainSessionId);
          }}
        />
      ) : null}
      {dialog?.kind === "botSettings" ? <BotSettingsDialog bot={dialog.bot} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "devices" ? <DevicesDialog onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "settings" ? <SettingsDialog onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "providers" ? (
        <ProvidersDialog onClose={() => setDialog(null)} onLocalModels={() => setDialog({ kind: "localModels" })} />
      ) : null}
      {dialog?.kind === "localModels" ? <LocalModelsDialog onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "session" ? (
        <NewSessionDialog
          bot={dialog.bot}
          onClose={() => setDialog(null)}
          onCreated={(s) => {
            setDialog(null);
            setSelectedId(s.id);
          }}
        />
      ) : null}
    </div>
  );
}
