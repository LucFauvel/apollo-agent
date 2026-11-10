import type { Bot, BotLimits, ProviderKind, ProviderSelection, RuntimeMode, Session } from "@apollo/contracts";
import { type BotAvatar as BotAvatarValue, type ProjectInfo, randomAvatar } from "@apollo/contracts";
import { AvatarPicker } from "./BlobAvatar.tsx";
import { FolderGit2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { slugify, suggestBotName, tildify, useAppSettings } from "../appSettings.ts";
import { formatUsage, usageTitle } from "../format.ts";
import { errorMessage, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";
import { useProviderVersions } from "../versions.ts";
import { type ModelChoice, ModelPicker } from "./ModelPicker.tsx";
import { ClaudeLogo, ProviderLogo } from "./icons.tsx";
import { AccountSelect } from "./Accounts.tsx";
import { LocalModelSetup } from "./LocalModelsDialog.tsx";
import { BotAvatar } from "./Sidebar.tsx";
import {
  Button,
  cx,
  ErrorText,
  Field,
  FormSection,
  inputClass,
  Modal,
  OptionCards,
  PROVIDERS,
  providerName,
  Toggle,
} from "./ui.tsx";

export const NO_CHOICE: ModelChoice = { model: null, effort: null };

export const selection = (provider: ProviderKind, choice: ModelChoice): ProviderSelection => ({
  provider,
  ...(choice.model?.trim() ? { model: choice.model.trim() } : {}),
  ...(choice.effort ? { effort: choice.effort } : {}),
});

export function ProviderPicker({
  value,
  onChange,
}: {
  value: ProviderKind;
  onChange: (provider: ProviderKind) => void;
}) {
  // Claude, Codex and llama.cpp always show; the other agents once their CLI is installed
  // (Antigravity installs itself on first use).
  const { versions } = useProviderVersions();
  const shown = PROVIDERS.filter(
    ({ kind }) =>
      kind === value ||
      kind === "claude" ||
      kind === "codex" ||
      kind === "llamacpp" ||
      kind === "antigravity" ||
      versions.some((v) => v.provider === kind && v.installed !== null),
  );
  return (
    <OptionCards
      value={value}
      onChange={onChange}
      options={shown.map(({ kind, name, detail }) => ({
        value: kind,
        label: name,
        detail,
        icon: <ProviderLogo provider={kind} size={18} />,
      }))}
    />
  );
}

/** Provider cards with the model and effort picker underneath. */
/** The bot's Claude and Codex accounts, picked beside the model for those providers. */
type AccountChoice = { value: string | null; onChange: (accountId: string | null) => void };
type AccountChoices = { readonly claude: AccountChoice; readonly codex: AccountChoice };

/** The model picker, with the account dropdown beside it for Claude Code and Codex. */
function ModelRow({ provider, account, children }: { provider: ProviderKind; account: AccountChoices | undefined; children: React.ReactNode }) {
  if ((provider !== "claude" && provider !== "codex") || !account) return <>{children}</>;
  const choice = account[provider];
  return (
    <div className="flex items-start gap-2">
      <AccountSelect provider={provider} value={choice.value} onChange={choice.onChange} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function ProviderModelPicker({
  provider,
  onProvider,
  choice,
  onChoice,
  account,
}: {
  provider: ProviderKind;
  onProvider: (provider: ProviderKind) => void;
  choice: ModelChoice;
  onChoice: (choice: ModelChoice) => void;
  account?: AccountChoices;
}) {
  // A model downloaded from the inline setup becomes the choice straight away.
  const onSelect = useCallback((model: string) => onChoice({ model, effort: null }), [onChoice]);
  return (
    <div className="space-y-2">
      <ProviderPicker value={provider} onChange={onProvider} />
      <ModelRow provider={provider} account={account}>
        <ModelPicker provider={provider} value={choice} onChange={onChoice} quietErrors={provider === "llamacpp"} />
      </ModelRow>
      {provider === "llamacpp" ? <LocalModelSetup onSelect={onSelect} /> : null}
    </div>
  );
}

/** The model picker for a provider that cannot change, labelled with its logo. */
function FixedProviderModel({
  provider,
  choice,
  onChoice,
  account,
}: {
  provider: ProviderKind;
  choice: ModelChoice;
  onChoice: (choice: ModelChoice) => void;
  account?: AccountChoices;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[13px] text-zinc-300">
        <ProviderLogo provider={provider} size={16} />
        {providerName(provider)}
      </div>
      <ModelRow provider={provider} account={account}>
        <ModelPicker provider={provider} value={choice} onChange={onChoice} />
      </ModelRow>
    </div>
  );
}

const PERMISSIONS = [
  { value: "approval-required", label: "Ask first", detail: "Prompts before risky actions" },
  { value: "auto", label: "Auto", detail: "A reviewer model decides; asks you when unsure" },
  { value: "full-access", label: "Full access", detail: "Never prompts" },
] as const satisfies ReadonlyArray<{ value: RuntimeMode; label: string; detail: string }>;

/** A workspace path input that suggests the user's projects (from the project folders in Settings). */
function WorkspaceField({
  value,
  onChange,
  projects,
  home,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  projects: ReadonlyArray<ProjectInfo>;
  home: string;
  hint?: string;
}) {
  const listId = useId();
  return (
    <Field label="Workspace" hint={hint}>
      <div className="relative">
        <input
          className={cx(inputClass, "font-mono text-xs", projects.length > 0 && "pr-8")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="~/Apollo/atlas"
          list={projects.length > 0 ? listId : undefined}
          spellCheck={false}
        />
        {projects.length > 0 ? (
          <FolderGit2
            className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-zinc-600"
            aria-label={`${projects.length} projects to pick from`}
          />
        ) : null}
      </div>
      {projects.length > 0 ? (
        <datalist id={listId}>
          {projects.map((p) => (
            <option key={p.path} value={tildify(p.path, home)} label={p.name} />
          ))}
        </datalist>
      ) : null}
    </Field>
  );
}

export function NewBotDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (bot: Bot) => void }) {
  const bots = useApp((s) => s.bots);
  const { settings, projects } = useAppSettings();
  const [name, setName] = useState(() => suggestBotName([...bots.values()].map((b) => b.name)));
  const [avatar, setAvatar] = useState<BotAvatarValue>(() => randomAvatar());
  const [instructions, setInstructions] = useState("");
  const [cwd, setCwd] = useState("");
  // The workspace follows the name until the user edits it.
  const [cwdEdited, setCwdEdited] = useState(false);
  useEffect(() => {
    if (!cwdEdited && settings) setCwd(tildify(`${settings.workspaceRoot}/${slugify(name)}`, settings.homeDir));
  }, [name, cwdEdited, settings]);
  const [main, setMain] = useState<ProviderKind>("claude");
  const [mainModel, setMainModel] = useState<ModelChoice>(NO_CHOICE);
  const [worker, setWorker] = useState<ProviderKind>("codex");
  const [workerModel, setWorkerModel] = useState<ModelChoice>(NO_CHOICE);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("auto");
  const [autoLearn, setAutoLearn] = useState(true);
  const [claudeAccountId, setClaudeAccountId] = useState<string | null>(null);
  const [codexAccountId, setCodexAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const create = () => {
    setSaving(true);
    rpc((c) =>
      c["bots.create"]({
        name,
        avatar,
        instructions,
        cwd,
        main: selection(main, mainModel),
        defaultWorker: selection(worker, workerModel),
        runtimeMode,
        autoLearn,
        ...(claudeAccountId ? { claudeAccountId } : {}),
        ...(codexAccountId ? { codexAccountId } : {}),
      }),
    )
      .then(onCreated)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  return (
    <Modal
      wide
      title="New bot"
      description="A persona with an orchestrator you talk to, and workers it delegates to."
      icon={<AvatarPicker value={avatar} onChange={setAvatar} />}
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
      <FormSection title="Identity">
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
            placeholder="Atlas"
            autoFocus
          />
        </Field>
        <WorkspaceField
          value={cwd}
          onChange={(v) => {
            setCwd(v);
            setCwdEdited(true);
          }}
          projects={projects}
          home={settings?.homeDir ?? ""}
          hint={
            projects.length > 0
              ? "Created if it doesn't exist. Pick one of your projects to work in it directly."
              : "Created if it doesn't exist. Add your project folders in Settings to pick from them."
          }
        />
        <Field label="Instructions" hint="Persona and standing instructions, shared by every session of this bot.">
          <textarea
            className={cx(inputClass, "min-h-20")}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="You maintain the billing service. Prefer small PRs…"
          />
        </Field>
      </FormSection>
      <FormSection title="Orchestrator" description="The session you talk to. It plans and delegates.">
        <ProviderModelPicker account={{ claude: { value: claudeAccountId, onChange: setClaudeAccountId }, codex: { value: codexAccountId, onChange: setCodexAccountId } }}
          provider={main}
          onProvider={(p) => {
            setMain(p);
            setMainModel(NO_CHOICE);
          }}
          choice={mainModel}
          onChoice={setMainModel}
        />
      </FormSection>
      <FormSection title="Default worker" description="The bot can still pick any provider, model and effort per task.">
        <ProviderModelPicker account={{ claude: { value: claudeAccountId, onChange: setClaudeAccountId }, codex: { value: codexAccountId, onChange: setCodexAccountId } }}
          provider={worker}
          onProvider={(p) => {
            setWorker(p);
            setWorkerModel(NO_CHOICE);
          }}
          choice={workerModel}
          onChoice={setWorkerModel}
        />
      </FormSection>
      <FormSection title="Behaviour">
        <OptionCards value={runtimeMode} onChange={setRuntimeMode} options={PERMISSIONS} />
        <Toggle
          checked={autoLearn}
          onChange={setAutoLearn}
          label="Learn automatically"
          description="Reflect on finished sessions to save memories and propose skills."
        />
      </FormSection>
      <ErrorText>{error}</ErrorText>
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
  const [worktree, setWorktree] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const create = () => {
    setSaving(true);
    rpc((c) =>
      c["sessions.create"]({
        botId: bot.id,
        // Empty: the server names it from the first message.
        title: title.trim(),
        provider: selection(provider, model),
        cwd,
        ...(worktree ? { isolation: "worktree" as const } : {}),
        ...(prompt.trim() ? { prompt } : {}),
      }),
    )
      .then(onCreated)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  return (
    <Modal
      title="New session"
      description={`A worker session for ${bot.name}, outside the orchestrator.`}
      icon={<BotAvatar avatar={bot.avatar} size="lg" />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={create}>
            Start session
          </Button>
        </>
      }
    >
      <ProviderModelPicker
        provider={provider}
        onProvider={(p) => {
          setProvider(p);
          setModel(workerDefaults(p));
        }}
        choice={model}
        onChoice={setModel}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Title">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="From the first message" autoFocus />
        </Field>
        <Field label="Working directory">
          <input className={cx(inputClass, "font-mono text-xs")} value={cwd} onChange={(e) => setCwd(e.target.value)} />
        </Field>
      </div>
      <Toggle
        checked={worktree}
        onChange={setWorktree}
        label="Own git worktree"
        description="Works on a new branch in its own checkout, so it does not collide with other sessions. The working directory must be in a git repository."
      />
      <Field label="First message" hint="Optional. Sent as soon as the session starts.">
        <textarea className={cx(inputClass, "min-h-24")} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}

/** Title, model, effort and permissions of one session. Changes apply from its next turn. */
export function SessionSettingsDialog({ bot, session, onClose }: { bot: Bot; session: Session; onClose: () => void }) {
  const [title, setTitle] = useState(session.title);
  const [choice, setChoice] = useState<ModelChoice>({ model: session.model, effort: session.effort });
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode | null>(session.runtimeMode);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = session.status === "running" || session.status === "waiting-approval" || session.status === "starting";
  const botMode = PERMISSIONS.find((p) => p.value === bot.runtimeMode)!;

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
      title={session.role === "main" ? `${bot.name} · orchestrator` : "Session settings"}
      description={
        busy
          ? "The session is working: changes apply once its current turn ends."
          : "Changes apply from the next message. The conversation continues where it left off."
      }
      icon={
        <span className="flex size-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
          <ProviderLogo provider={session.provider} size={18} />
        </span>
      }
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
      <Field label="Model" hint="The provider is fixed for a session; start a new one to switch.">
        <FixedProviderModel provider={session.provider} choice={choice} onChoice={setChoice} />
      </Field>
      <Field label="Permissions">
        <OptionCards
          value={runtimeMode ?? "inherit"}
          onChange={(v) => setRuntimeMode(v === "inherit" ? null : v)}
          options={[{ value: "inherit", label: "Same as bot", detail: botMode.label }, ...PERMISSIONS]}
        />
      </Field>
      <ErrorText>{error}</ErrorText>
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
        className={cx(inputClass, "tabular-nums", invalid && "border-red-500/60 focus:border-red-500")}
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
  const [avatar, setAvatar] = useState<BotAvatarValue>(bot.avatar);
  const { settings, projects } = useAppSettings();
  const [instructions, setInstructions] = useState(bot.instructions);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(bot.runtimeMode);
  const [autoLearn, setAutoLearn] = useState(bot.autoLearn);
  const [claudeAccountId, setClaudeAccountId] = useState<string | null>(bot.claudeAccountId);
  const [codexAccountId, setCodexAccountId] = useState<string | null>(bot.codexAccountId);
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
        avatar,
        cwd,
        instructions,
        runtimeMode,
        autoLearn,
        main: selection(bot.main.provider, mainModel),
        defaultWorker: selection(worker, workerModel),
        limits,
        claudeAccountId,
        codexAccountId,
      }),
    )
      .then(onClose)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  // Shown instead of the settings (not over them), so Escape backs out of one dialog only.
  if (confirmingDelete) {
    return <DeleteBotDialog bot={bot} home={settings?.homeDir ?? ""} onCancel={() => setConfirmingDelete(false)} onDeleted={onClose} />;
  }

  return (
    <Modal
      title={`${bot.name} settings`}
      description={today ? <span title={usageTitle(today)}>Today so far: {formatUsage(today)}</span> : undefined}
      icon={<AvatarPicker value={avatar} onChange={setAvatar} />}
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
      <FormSection title="Identity">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <WorkspaceField value={cwd} onChange={setCwd} projects={projects} home={settings?.homeDir ?? ""} />
        </div>
        <Field label="Instructions">
          <textarea className={cx(inputClass, "min-h-20")} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </Field>
      </FormSection>
      <FormSection title="Orchestrator">
        <FixedProviderModel provider={bot.main.provider} choice={mainModel} onChoice={setMainModel} account={{ claude: { value: claudeAccountId, onChange: setClaudeAccountId }, codex: { value: codexAccountId, onChange: setCodexAccountId } }} />
      </FormSection>
      <FormSection title="Default worker">
        <ProviderModelPicker account={{ claude: { value: claudeAccountId, onChange: setClaudeAccountId }, codex: { value: codexAccountId, onChange: setCodexAccountId } }}
          provider={worker}
          onProvider={(p) => {
            setWorker(p);
            setWorkerModel(NO_CHOICE);
          }}
          choice={workerModel}
          onChoice={setWorkerModel}
        />
      </FormSection>
      <FormSection title="Behaviour">
        <OptionCards value={runtimeMode} onChange={setRuntimeMode} options={PERMISSIONS} />
        <Toggle
          checked={autoLearn}
          onChange={setAutoLearn}
          label="Learn automatically"
          description="Reflect on finished sessions to save memories and propose skills."
        />
      </FormSection>
      <FormSection
        title="Guardrails"
        description="When a limit is hit, the bot pauses: it stops starting and messaging workers until you resume it. Your own messages always go through."
      >
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
      </FormSection>
      <FormSection title="Danger zone">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-900/50 bg-red-950/20 px-3 py-2.5">
          <div className="min-w-0 text-xs text-zinc-400">
            <div className="font-medium text-zinc-200">Delete this bot</div>
            Removes its sessions, memories, skills and schedules. This cannot be undone.
          </div>
          <Button variant="danger" size="sm" disabled={saving} onClick={() => setConfirmingDelete(true)}>
            Delete this bot
          </Button>
        </div>
      </FormSection>
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}

/** Confirms deleting a bot: says what goes and what stays, and asks for its name. */
function DeleteBotDialog({ bot, home, onCancel, onDeleted }: { bot: Bot; home: string; onCancel: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed === bot.name;
  const cancel = useCallback(() => {
    if (!deleting) onCancel();
  }, [deleting, onCancel]);

  const remove = () => {
    if (!matches || deleting) return;
    setDeleting(true);
    setError(null);
    rpc((c) => c["bots.delete"]({ botId: bot.id }))
      .then(onDeleted)
      .catch((e) => {
        // Already gone (deleted elsewhere): nothing left to do.
        if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "not_found") return onDeleted();
        setError(errorMessage(e));
        setDeleting(false);
      });
  };

  return (
    <Modal
      title={`Delete ${bot.name}?`}
      description="This cannot be undone."
      onClose={cancel}
      footer={
        <>
          <Button variant="ghost" disabled={deleting} onClick={cancel}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!matches || deleting} onClick={remove}>
            {deleting ? "Deleting…" : "Delete bot"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-xs text-zinc-400">
        <div>
          <div className="mb-1 font-medium text-red-300">Deleted</div>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>Its orchestrator and every worker session, with their conversations, attachments and worktrees</li>
            <li>Its memories, notes and skills</li>
            <li>Its schedules, running background jobs and browser tabs</li>
          </ul>
        </div>
        <div>
          <div className="mb-1 font-medium text-zinc-200">Kept</div>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              The workspace folder <span className="font-mono text-zinc-300">{home ? tildify(bot.cwd, home) : bot.cwd}</span> and its files
            </li>
            <li>The shared user profile, shared memories, and your other bots</li>
          </ul>
        </div>
      </div>
      <Field label={`Type ${bot.name} to confirm`}>
        <input
          className={inputClass}
          value={typed}
          autoFocus
          disabled={deleting}
          placeholder={bot.name}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && remove()}
        />
      </Field>
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}
