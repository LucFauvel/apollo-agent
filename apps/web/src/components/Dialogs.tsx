import type { Bot, ProviderKind, RuntimeMode, Session } from "@apollo/contracts";
import { useState } from "react";
import { errorMessage, rpc } from "../rpc.ts";
import { Button, cx, Field, inputClass, Modal } from "./ui.tsx";

function ProviderPicker({
  value,
  onChange,
}: {
  value: ProviderKind;
  onChange: (provider: ProviderKind) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {(["claude", "codex"] as const).map((provider) => (
        <button
          key={provider}
          type="button"
          onClick={() => onChange(provider)}
          className={cx(
            "rounded-md border px-3 py-2 text-left text-sm",
            value === provider
              ? "border-zinc-400 bg-zinc-800 text-zinc-100"
              : "border-zinc-800 text-zinc-400 hover:border-zinc-700",
          )}
        >
          <div className="font-medium">{provider === "claude" ? "Claude Code" : "Codex"}</div>
          <div className="text-[11px] text-zinc-500">{provider === "claude" ? "Agent SDK" : "app-server"}</div>
        </button>
      ))}
    </div>
  );
}

export function NewBotDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (bot: Bot) => void }) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [cwd, setCwd] = useState("");
  const [main, setMain] = useState<ProviderKind>("claude");
  const [mainModel, setMainModel] = useState("");
  const [worker, setWorker] = useState<ProviderKind>("codex");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("approval-required");
  const [autoLearn, setAutoLearn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const create = () => {
    setSaving(true);
    rpc((c) =>
      c["bots.create"]({
        name,
        instructions,
        cwd,
        main: { provider: main, ...(mainModel.trim() ? { model: mainModel.trim() } : {}) },
        defaultWorker: { provider: worker },
        runtimeMode,
        autoLearn,
      }),
    )
      .then(onCreated)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  return (
    <Modal
      title="New bot"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || !cwd.trim() || saving} onClick={create}>
            Create bot
          </Button>
        </>
      }
    >
      <Field label="Name">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Atlas" autoFocus />
      </Field>
      <Field label="Workspace" hint="Default working directory for this bot's sessions.">
        <input className={inputClass} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/home/me/projects/app" />
      </Field>
      <Field label="Instructions" hint="Persona and standing instructions, shared by every session of this bot.">
        <textarea
          className={cx(inputClass, "min-h-20")}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="You maintain the billing service. Prefer small PRs…"
        />
      </Field>
      <Field label="Orchestrator provider">
        <ProviderPicker value={main} onChange={setMain} />
      </Field>
      <Field label="Orchestrator model" hint="Optional. Leave empty for the provider's default.">
        <input className={inputClass} value={mainModel} onChange={(e) => setMainModel(e.target.value)} placeholder="default" />
      </Field>
      <Field label="Default worker provider" hint="The bot can still pick either provider per task.">
        <ProviderPicker value={worker} onChange={setWorker} />
      </Field>
      <Field label="Permissions">
        <select
          className={inputClass}
          value={runtimeMode}
          onChange={(e) => setRuntimeMode(e.target.value as RuntimeMode)}
        >
          <option value="approval-required">Ask before risky actions</option>
          <option value="full-access">Full access (no prompts)</option>
        </select>
      </Field>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={autoLearn} onChange={(e) => setAutoLearn(e.target.checked)} />
        Learn automatically (reflect on sessions to save memories and propose skills)
      </label>
      {error ? <div className="text-xs text-red-400">{error}</div> : null}
    </Modal>
  );
}

export function NewSessionDialog({
  bot,
  onClose,
  onCreated,
}: {
  bot: Bot;
  onClose: () => void;
  onCreated: (session: Session) => void;
}) {
  const [title, setTitle] = useState("");
  const [provider, setProvider] = useState<ProviderKind>(bot.defaultWorker.provider);
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState(bot.cwd);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const create = () => {
    setSaving(true);
    rpc((c) =>
      c["sessions.create"]({
        botId: bot.id,
        title: title || prompt.slice(0, 48),
        provider: { provider, ...(model.trim() ? { model: model.trim() } : {}) },
        cwd,
        ...(prompt.trim() ? { prompt } : {}),
      }),
    )
      .then(onCreated)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  return (
    <Modal
      title={`New session · ${bot.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={(!title.trim() && !prompt.trim()) || saving} onClick={create}>
            Start session
          </Button>
        </>
      }
    >
      <Field label="Provider">
        <ProviderPicker value={provider} onChange={setProvider} />
      </Field>
      <Field label="Title">
        <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix flaky tests" autoFocus />
      </Field>
      <Field label="Model" hint="Optional.">
        <input className={inputClass} value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" />
      </Field>
      <Field label="Working directory">
        <input className={inputClass} value={cwd} onChange={(e) => setCwd(e.target.value)} />
      </Field>
      <Field label="First message" hint="Optional. Sent as soon as the session starts.">
        <textarea className={cx(inputClass, "min-h-24")} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
      {error ? <div className="text-xs text-red-400">{error}</div> : null}
    </Modal>
  );
}
