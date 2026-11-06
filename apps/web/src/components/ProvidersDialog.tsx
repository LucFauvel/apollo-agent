import {
  type ClaudeAuth,
  type ProviderKind,
  isDownloaded,
  type LlamaCppMode,
  type ModelOption,
  type ProviderSettings,
  type UpdateProviderSettingsInput,
} from "@apollo/contracts";
import { ArrowUpCircle, Blocks, Check, CircleAlert, HardDrive, KeyRound, Loader2, LogIn, Server } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { forgetModels } from "../models.ts";
import { errorMessage, rpc } from "../rpc.ts";
import { updateProvider, useProviderVersions } from "../versions.ts";
import { setLocalModels, useApp } from "../store.ts";
import { ClaudeLogo, CodexLogo, LlamaLogo } from "./icons.tsx";
import { Button, cx, ErrorText, Field, inputClass, Modal, OptionCards, Toggle } from "./ui.tsx";

type Check = { status: "idle" | "checking" } | { status: "ok"; models: ReadonlyArray<ModelOption> } | { status: "error"; error: string };

/**
 * A write-only key field. Empty keeps the saved key; the saved key is never sent
 * back to the browser.
 */
function KeyInput({
  saved,
  value,
  cleared,
  onChange,
  onClear,
  placeholder,
}: {
  saved: boolean;
  value: string;
  cleared: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
  placeholder: string;
}) {
  return (
    <div className="flex gap-2">
      <input
        type="password"
        autoComplete="off"
        className={cx(inputClass, "font-mono text-xs")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={saved && !cleared ? "Saved. Type to replace it." : placeholder}
      />
      {saved && !cleared ? (
        <Button variant="ghost" onClick={onClear}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}

/** One provider's settings, headed by its logo. */
/** The installed version, with an Update button when a newer one is out. */
function VersionBadge({ provider }: { provider: ProviderKind }) {
  const { versions, updating, error } = useProviderVersions();
  // A llama.cpp install reports its progress through the local models state.
  const installing = useApp((s) => (provider === "llamacpp" ? (s.localModels?.engine.installing ?? null) : null));
  const v = versions.find((x) => x.provider === provider);
  if (installing) {
    const { done, total } = installing.progress;
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-sky-300 tabular-nums" title={installing.step}>
        <Loader2 className="size-3 animate-spin" />
        {installing.step}
        {total > 0 ? ` · ${Math.floor((done / total) * 100)}%` : ""}
      </span>
    );
  }
  if (!v) return null;
  const busy = updating.has(provider);
  if (error?.startsWith(`${provider}: `)) {
    return (
      <span className="max-w-64 shrink-0 truncate text-[11px] text-red-300" title={error}>
        Update failed: {error.slice(provider.length + 2)}
      </span>
    );
  }
  if (v.updateAvailable) {
    return (
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-[11px] text-amber-300 tabular-nums">
          {v.installed} → {v.latest}
        </span>
        {v.canUpdate ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void updateProvider(provider)}>
            {busy ? <Loader2 className="animate-spin" /> : <ArrowUpCircle />} {busy ? "Updating…" : "Update"}
          </Button>
        ) : null}
      </span>
    );
  }
  return (
    <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums" title={v.note ?? undefined}>
      {v.installed ? `${v.installed} · up to date` : (v.note ?? "")}
    </span>
  );
}

function ProviderSection({
  logo,
  name,
  detail,
  provider,
  children,
}: {
  logo: ReactNode;
  name: string;
  detail: string;
  provider?: ProviderKind;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-zinc-800/80 bg-zinc-900/20 p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">{logo}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-zinc-100">{name}</h3>
          <p className="text-[11px] text-zinc-500">{detail}</p>
        </div>
        {provider ? <VersionBadge provider={provider} /> : null}
      </div>
      {children}
    </section>
  );
}

const iconClass = "size-4 text-zinc-400";

/** One line on the managed llama.cpp setup. */
function ManagedSummary() {
  const state = useApp((s) => s.localModels);
  useEffect(() => {
    void rpc((c) => c["localModels.state"]()).then(setLocalModels);
  }, []);
  if (!state) return <span className="text-zinc-500">Checking…</span>;
  if (!state.engine.installed) return <span className="text-zinc-400">llama.cpp is not installed yet.</span>;
  const ready = state.models.filter(isDownloaded).length;
  const dot = { running: "bg-emerald-500", starting: "bg-amber-500 animate-pulse", stopped: "bg-zinc-600", error: "bg-red-500" }[
    state.server.status
  ];
  return (
    <span className="flex items-center gap-2 text-zinc-400">
      <span className={cx("size-1.5 shrink-0 rounded-full", dot)} title={`Server ${state.server.status}`} />
      <span className="font-mono text-zinc-300">{state.engine.installed.tag}</span>
      <span className="text-zinc-600">·</span>
      {ready === 0 ? "no models yet" : `${ready} model${ready === 1 ? "" : "s"}`}
      <span className="text-zinc-600">·</span>
      server {state.server.status}
    </span>
  );
}

export function ProvidersDialog({ onClose, onLocalModels }: { onClose: () => void; onLocalModels: () => void }) {
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [auth, setAuth] = useState<ClaudeAuth>("subscription");
  const [claudeKey, setClaudeKey] = useState("");
  const [claudeKeyCleared, setClaudeKeyCleared] = useState(false);
  const [mode, setMode] = useState<LlamaCppMode>("managed");
  const [baseUrl, setBaseUrl] = useState("");
  const [llamaKey, setLlamaKey] = useState("");
  const [llamaKeyCleared, setLlamaKeyCleared] = useState(false);
  const [check, setCheck] = useState<Check>({ status: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = (next: ProviderSettings) => {
    setSettings(next);
    setAuth(next.claude.auth);
    setMode(next.llamacpp.mode);
    setBaseUrl(next.llamacpp.baseUrl);
    setClaudeKey("");
    setLlamaKey("");
    setClaudeKeyCleared(false);
    setLlamaKeyCleared(false);
  };

  useEffect(() => {
    rpc((c) => c["providers.settings"]())
      .then(load)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const keyUpdate = (typed: string, cleared: boolean) => (typed.trim() ? typed.trim() : cleared ? null : undefined);

  const save = async () => {
    const claudeApiKey = keyUpdate(claudeKey, claudeKeyCleared);
    const llamaApiKey = keyUpdate(llamaKey, llamaKeyCleared);
    const input: UpdateProviderSettingsInput = {
      claude: { auth, ...(claudeApiKey !== undefined ? { apiKey: claudeApiKey } : {}) },
      llamacpp: { mode, baseUrl, ...(llamaApiKey !== undefined ? { apiKey: llamaApiKey } : {}) },
    };
    const next = await rpc((c) => c["providers.updateSettings"](input));
    forgetModels();
    load(next);
    return next;
  };

  const run = (action: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    action()
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  const testLlama = () =>
    run(async () => {
      await save();
      setCheck({ status: "checking" });
      await rpc((c) => c["providers.models"]({ provider: "llamacpp" })).then(
        (models) => setCheck({ status: "ok", models }),
        (e) => setCheck({ status: "error", error: errorMessage(e) }),
      );
    });

  const needsClaudeKey = auth === "api-key" && !claudeKey.trim() && (!settings?.claude.apiKeySaved || claudeKeyCleared);

  return (
    <Modal
      title="Providers"
      description="Credentials and endpoints. Changes apply to sessions that start after you save."
      icon={
        <span className="flex size-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
          <Blocks className="size-4.5 text-zinc-400" strokeWidth={1.75} />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!settings || saving || needsClaudeKey}
            onClick={() => run(() => save().then(onClose))}
          >
            Save
          </Button>
        </>
      }
    >
      {settings ? (
        <>
          <ProviderSection provider="claude" logo={<ClaudeLogo size={20} />} name="Claude Code" detail="Anthropic · runs through the Claude Agent SDK">
            <OptionCards
              value={auth}
              onChange={setAuth}
              options={[
                {
                  value: "subscription",
                  label: "Claude login",
                  detail: "Your claude login: subscription or Console",
                  icon: <LogIn className={iconClass} />,
                },
                { value: "api-key", label: "API key", detail: "Billed to the key's Console account", icon: <KeyRound className={iconClass} /> },
              ]}
            />
            <Field
              label="Anthropic API key"
              hint={
                auth === "api-key"
                  ? "Used for every Claude session. Switch back to Claude login at any time; the key stays saved."
                  : "Saved for later. Claude sessions use your Claude login while it is selected."
              }
            >
              <KeyInput
                saved={settings.claude.apiKeySaved}
                value={claudeKey}
                cleared={claudeKeyCleared}
                onChange={setClaudeKey}
                onClear={() => setClaudeKeyCleared(true)}
                placeholder="sk-ant-…"
              />
            </Field>
          </ProviderSection>

          <ProviderSection provider="codex" logo={<CodexLogo size={20} />} name="Codex" detail="OpenAI · runs through codex app-server">
            <p className="text-[11px] text-zinc-500">
              Uses the <span className="font-mono text-zinc-400">codex</span> CLI on this machine and its login. Run{" "}
              <span className="font-mono text-zinc-400">codex login</span> to sign in.
            </p>
          </ProviderSection>

          <ProviderSection
            provider="llamacpp"
            logo={<LlamaLogo size={20} />}
            name="llama.cpp"
            detail="Local models with the Claude Code harness: tools, MCP, skills and approvals work as with Claude."
          >
            <OptionCards
              value={mode}
              onChange={setMode}
              options={[
                {
                  value: "managed",
                  label: "Managed by Apollo",
                  detail: "Installs, runs and updates llama-server",
                  icon: <HardDrive className={iconClass} />,
                },
                { value: "external", label: "My own server", detail: "A llama-server you run yourself", icon: <Server className={iconClass} /> },
              ]}
            />
            <Toggle
              checked={settings.llamacpp.allowSubagents}
              onChange={(allowSubagents) =>
                run(() => rpc((c) => c["providers.updateSettings"]({ llamacpp: { allowSubagents } })).then((next) => setSettings(next)))
              }
              label="Let local models start subagents"
              description="Each subagent is another run of the local model at the same time. Off: they hand work to Apollo workers instead."
            />
            {mode === "managed" ? (
              <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 py-2 pr-2 pl-3 text-xs">
                <span className="min-w-0 flex-1">
                  <ManagedSummary />
                </span>
                <Button size="sm" onClick={() => run(() => save().then(onLocalModels))} disabled={saving}>
                  Manage local models
                </Button>
              </div>
            ) : (
              <>
                <p className="text-[11px] text-zinc-500">
                  Start it with{" "}
                  <span className="font-mono text-zinc-400">llama-server -m model.gguf --jinja -c 65536</span>: a context
                  of 64k tokens or more.
                </p>
                <Field label="Server address">
                  <input
                    className={cx(inputClass, "font-mono text-xs")}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="http://127.0.0.1:8080"
                  />
                </Field>
                <Field label="API key" hint="Only if llama-server was started with --api-key.">
                  <KeyInput
                    saved={settings.llamacpp.apiKeySaved}
                    value={llamaKey}
                    cleared={llamaKeyCleared}
                    onChange={setLlamaKey}
                    onClear={() => setLlamaKeyCleared(true)}
                    placeholder="None"
                  />
                </Field>
                <div className="flex items-center gap-3">
                  <Button size="sm" disabled={saving} onClick={testLlama}>
                    Save and test
                  </Button>
                  <span className="min-w-0 text-[11px]">
                    {check.status === "checking" ? (
                      <span className="flex items-center gap-1 text-zinc-500">
                        <Loader2 className="size-3 animate-spin" /> Connecting…
                      </span>
                    ) : null}
                    {check.status === "ok" ? (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <Check className="size-3" /> Connected:{" "}
                        {check.models.length === 0 ? "no model loaded" : check.models.map((m) => m.label).join(", ")}
                      </span>
                    ) : null}
                    {check.status === "error" ? (
                      <span className="flex items-center gap-1 text-red-400">
                        <CircleAlert className="size-3" /> {check.error}
                      </span>
                    ) : null}
                  </span>
                </div>
              </>
            )}
          </ProviderSection>
        </>
      ) : (
        <p className="text-sm text-zinc-500">Loading…</p>
      )}
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}
