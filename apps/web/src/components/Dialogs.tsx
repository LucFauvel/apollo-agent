import type { Bot, BotLimits, ProviderKind, ProviderSelection, RuntimeMode, Session } from "@apollo/contracts";
import { useState } from "react";
import { formatUsage, usageTitle } from "../format.ts";
import { errorMessage, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";
import { type ModelChoice, ModelPicker } from "./ModelPicker.tsx";
import { Button, cx, Field, inputClass, Modal, PROVIDERS } from "./ui.tsx";

const NO_CHOICE: ModelChoice = { model: null, effort: null };

const selection = (provider: ProviderKind, choice: ModelChoice): ProviderSelection => ({
  provider,
  ...(choice.model?.trim() ? { model: choice.model.trim() } : {}),
  ...(choice.effort ? { effort: choice.effort } : {}),
});

function ProviderPicker({
  value,
  onChange,
}: {
  value: ProviderKind;
  onChange: (provider: ProviderKind) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {PROVIDERS.map(({ kind: provider, name, detail }) => (
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
          <div className="font-medium">{name}</div>
          <div className="truncate text-[11px] text-zinc-500">{detail}</div>
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
  const [mainModel, setMainModel] = useState<ModelChoice>(NO_CHOICE);
  const [worker, setWorker] = useState<ProviderKind>("codex");
  const [workerModel, setWorkerModel] = useState<ModelChoice>(NO_CHOICE);
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
        main: selection(main, mainModel),
        defaultWorker: selection(worker, workerModel),
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
      <Field label="Orchestrator">
        <div className="space-y-2">
          <ProviderPicker
            value={main}
            onChange={(p) => {
              setMain(p);
              setMainModel(NO_CHOICE);
            }}
          />
          <ModelPicker provider={main} value={mainModel} onChange={setMainModel} />
        </div>
      </Field>
      <Field label="Default worker" hint="The bot can still pick either provider, model and effort per task.">
        <div className="space-y-2">
          <ProviderPicker
            value={worker}
            onChange={(p) => {
              setWorker(p);
              setWorkerModel(NO_CHOICE);
            }}
          />
          <ModelPicker provider={worker} value={workerModel} onChange={setWorkerModel} />
        </div>
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
  const workerDefaults = (p: ProviderKind): ModelChoice =>
    p === bot.defaultWorker.provider
      ? { model: bot.defaultWorker.model ?? null, effort: bot.defaultWorker.effort ?? null }
      : NO_CHOICE;
  const [model, setModel] = useState<ModelChoice>(() => workerDefaults(bot.defaultWorker.provider));
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
        provider: selection(provider, model),
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
        <div className="space-y-2">
          <ProviderPicker
            value={provider}
            onChange={(p) => {
              setProvider(p);
              setModel(workerDefaults(p));
            }}
          />
          <ModelPicker provider={provider} value={model} onChange={setModel} />
        </div>
      </Field>
      <Field label="Title">
        <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix flaky tests" autoFocus />
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

const runtimeLabel: Record<RuntimeMode, string> = {
  "approval-required": "Ask before risky actions",
  "full-access": "Full access (no prompts)",
};

/** Title, model, effort and permissions of one session. Changes apply from its next turn. */
export function SessionSettingsDialog({ bot, session, onClose }: { bot: Bot; session: Session; onClose: () => void }) {
  const [title, setTitle] = useState(session.title);
  const [choice, setChoice] = useState<ModelChoice>({ model: session.model, effort: session.effort });
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode | null>(session.runtimeMode);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = session.status === "running" || session.status === "waiting-approval" || session.status === "starting";

  const save = () => {
    setSaving(true);
    rpc((c) =>
      c["sessions.update"]({
        sessionId: session.id,
        ...(session.role !== "main" ? { title } : {}),
        model: choice.model?.trim() || null,
        effort: choice.effort,
        runtimeMode,
      }),
    )
      .then(onClose)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  return (
    <Modal
      title={session.role === "main" ? `${bot.name} · orchestrator settings` : "Session settings"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving || (session.role !== "main" && !title.trim())} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      {session.role !== "main" ? (
        <Field label="Title">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
      ) : null}
      <Field
        label={`Model · ${session.provider === "claude" ? "Claude Code" : "Codex"}`}
        hint="The provider is fixed for a session; start a new one to switch."
      >
        <ModelPicker provider={session.provider} value={choice} onChange={setChoice} />
      </Field>
      <Field label="Permissions">
        <select
          className={inputClass}
          value={runtimeMode ?? ""}
          onChange={(e) => setRuntimeMode((e.target.value || null) as RuntimeMode | null)}
        >
          <option value="">Same as bot ({runtimeLabel[bot.runtimeMode].toLowerCase()})</option>
          <option value="approval-required">{runtimeLabel["approval-required"]}</option>
          <option value="full-access">{runtimeLabel["full-access"]}</option>
        </select>
      </Field>
      <p className="text-[11px] text-zinc-500">
        {busy
          ? "The session is working: changes apply once its current turn ends."
          : "Changes apply from the next message. The conversation continues where it left off."}
      </p>
      {error ? <div className="text-xs text-red-400">{error}</div> : null}
    </Modal>
  );
}

/** A positive number from a text field; empty means "no limit" where allowed. */
const parseLimit = (text: string, { integer, optional }: { integer: boolean; optional: boolean }) => {
  const trimmed = text.trim().replace(/[$,_\s]/g, "");
  if (trimmed === "") return optional ? null : Number.NaN;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 && (!integer || Number.isInteger(n)) ? n : Number.NaN;
};

function LimitField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  invalid,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  invalid: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        className={cx(inputClass, invalid && "border-red-500/60")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
      />
    </Field>
  );
}

/** Everything about a bot after creation, including its guardrails. */
export function BotSettingsDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const today = useApp((s) => s.usageToday.get(bot.id));
  const [name, setName] = useState(bot.name);
  const [cwd, setCwd] = useState(bot.cwd);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(bot.runtimeMode);
  const [autoLearn, setAutoLearn] = useState(bot.autoLearn);
  const [mainModel, setMainModel] = useState<ModelChoice>({ model: bot.main.model ?? null, effort: bot.main.effort ?? null });
  const [worker, setWorker] = useState<ProviderKind>(bot.defaultWorker.provider);
  const [workerModel, setWorkerModel] = useState<ModelChoice>({
    model: bot.defaultWorker.model ?? null,
    effort: bot.defaultWorker.effort ?? null,
  });
  const [maxWorkers, setMaxWorkers] = useState(String(bot.limits.maxConcurrentWorkers));
  const [maxTurns, setMaxTurns] = useState(String(bot.limits.maxAutonomousTurns));
  const [tokenBudget, setTokenBudget] = useState(bot.limits.dailyTokenBudget?.toString() ?? "");
  const [costBudget, setCostBudget] = useState(bot.limits.dailyCostBudgetUsd?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const limits: BotLimits = {
    maxConcurrentWorkers: parseLimit(maxWorkers, { integer: true, optional: false })!,
    maxAutonomousTurns: parseLimit(maxTurns, { integer: true, optional: false })!,
    dailyTokenBudget: parseLimit(tokenBudget, { integer: true, optional: true }),
    dailyCostBudgetUsd: parseLimit(costBudget, { integer: false, optional: true }),
  };
  const invalid = (n: number | null) => n !== null && Number.isNaN(n);
  const limitsValid = !Object.values(limits).some(invalid);

  const save = () => {
    setSaving(true);
    setError(null);
    rpc((c) =>
      c["bots.update"]({
        botId: bot.id,
        name,
        cwd,
        instructions,
        runtimeMode,
        autoLearn,
        main: selection(bot.main.provider, mainModel),
        defaultWorker: selection(worker, workerModel),
        limits,
      }),
    )
      .then(onClose)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  return (
    <Modal
      title={`${bot.name} · settings`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || !limitsValid || saving} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Workspace">
        <input className={inputClass} value={cwd} onChange={(e) => setCwd(e.target.value)} />
      </Field>
      <Field label="Instructions">
        <textarea className={cx(inputClass, "min-h-20")} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </Field>
      <Field label={`Orchestrator model · ${bot.main.provider === "claude" ? "Claude Code" : "Codex"}`}>
        <ModelPicker provider={bot.main.provider} value={mainModel} onChange={setMainModel} />
      </Field>
      <Field label="Default worker">
        <div className="space-y-2">
          <ProviderPicker
            value={worker}
            onChange={(p) => {
              setWorker(p);
              setWorkerModel(NO_CHOICE);
            }}
          />
          <ModelPicker provider={worker} value={workerModel} onChange={setWorkerModel} />
        </div>
      </Field>
      <Field label="Permissions">
        <select className={inputClass} value={runtimeMode} onChange={(e) => setRuntimeMode(e.target.value as RuntimeMode)}>
          <option value="approval-required">{runtimeLabel["approval-required"]}</option>
          <option value="full-access">{runtimeLabel["full-access"]}</option>
        </select>
      </Field>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={autoLearn} onChange={(e) => setAutoLearn(e.target.checked)} />
        Learn automatically
      </label>

      <div className="space-y-3 border-t border-zinc-800 pt-4">
        <div>
          <div className="text-sm font-medium text-zinc-200">Guardrails</div>
          <p className="text-[11px] text-zinc-500">
            When a limit is hit, the bot pauses: it stops starting and messaging workers until you resume it. Your own
            messages always go through.
            {today ? (
              <span title={usageTitle(today)}> Today so far: {formatUsage(today)}.</span>
            ) : null}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <LimitField
            label="Workers at once"
            hint="Running at the same time."
            value={maxWorkers}
            onChange={setMaxWorkers}
            invalid={invalid(limits.maxConcurrentWorkers)}
          />
          <LimitField
            label="Turns without you"
            hint="Orchestrator turns in a row you did not start."
            value={maxTurns}
            onChange={setMaxTurns}
            invalid={invalid(limits.maxAutonomousTurns)}
          />
          <LimitField
            label="Daily token budget"
            hint="Fresh input + output. Empty: no limit."
            value={tokenBudget}
            onChange={setTokenBudget}
            placeholder="No limit"
            invalid={invalid(limits.dailyTokenBudget)}
          />
          <LimitField
            label="Daily cost budget (USD)"
            hint="Estimated; Claude only. Empty: no limit."
            value={costBudget}
            onChange={setCostBudget}
            placeholder="No limit"
            invalid={invalid(limits.dailyCostBudgetUsd)}
          />
        </div>
      </div>
      {error ? <div className="text-xs text-red-400">{error}</div> : null}
    </Modal>
  );
}
