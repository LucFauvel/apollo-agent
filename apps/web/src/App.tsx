import { showApp, watchTurns } from "./turnNotifications.ts";
import type { Bot, SessionId } from "@apollo/contracts";
import { useEffect, useRef, useState } from "react";
import { BotSettingsDialog, NewBotDialog, NewSessionDialog } from "./components/Dialogs.tsx";
import { BrowserPanel } from "./components/BrowserPanel.tsx";
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
import { onNotify, startSync, useApp } from "./store.ts";

/** Shows server notifications (scheduled results, failures) on the desktop; clicking opens the session. */
const useDesktopNotifications = (open: (id: SessionId) => void) =>
  useEffect(
    () =>
      onNotify((notice) => {
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        const notification = new Notification(notice.title, { body: notice.body });
        notification.onclick = () => {
          showApp();
          if (notice.sessionId) open(notice.sessionId);
        };
      }),
    [open],
  );

export function App() {
  useEffect(() => startSync(), []);

  const [selectedId, setSelectedId] = useState<SessionId | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "bot" } | { kind: "session"; bot: Bot } | { kind: "botSettings"; bot: Bot } | { kind: "devices" } | { kind: "providers" } | { kind: "localModels" } | { kind: "settings" } | null
  >(null);
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const togglePanel = (next: PanelKind) => setPanel((current) => (current === next ? null : next));
  useDesktopNotifications(setSelectedId);
  // Turn notifications compare against the open session; read it through a ref.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => watchTurns(() => selectedRef.current, setSelectedId), []);

  const session = useApp((s) => (selectedId ? s.sessions.get(selectedId) : undefined));
  const bot = useApp((s) => (session ? s.bots.get(session.botId) : undefined));
  const firstBot = useApp((s) => s.bots.values().next().value);

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
