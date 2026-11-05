import type { Bot, SessionId } from "@apollo/contracts";
import { useEffect, useState } from "react";
import { BotSettingsDialog, NewBotDialog, NewSessionDialog } from "./components/Dialogs.tsx";
import { DevicesDialog } from "./components/DevicesDialog.tsx";
import { LocalModelsDialog } from "./components/LocalModelsDialog.tsx";
import { ProvidersDialog } from "./components/ProvidersDialog.tsx";
import { KnowledgePanel } from "./components/KnowledgePanel.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Button } from "./components/ui.tsx";
import { startSync, useApp } from "./store.ts";

export function App() {
  useEffect(() => startSync(), []);

  const [selectedId, setSelectedId] = useState<SessionId | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "bot" } | { kind: "session"; bot: Bot } | { kind: "botSettings"; bot: Bot } | { kind: "devices" } | { kind: "providers" } | { kind: "localModels" } | null
  >(null);
  const [showKnowledge, setShowKnowledge] = useState(false);

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
      />
      {session && bot ? (
        <SessionView session={session} bot={bot} onShowKnowledge={() => setShowKnowledge((v) => !v)} />
      ) : (
        <main className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="text-lg font-semibold text-zinc-100">Apollo</div>
          <p className="max-w-sm text-sm text-zinc-500">
            Bots orchestrate Claude Code and Codex sessions, and share memory and skills across them.
          </p>
          <Button variant="primary" onClick={() => setDialog({ kind: "bot" })}>
            Create a bot
          </Button>
        </main>
      )}
      {showKnowledge && bot ? <KnowledgePanel bot={bot} onClose={() => setShowKnowledge(false)} /> : null}

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
