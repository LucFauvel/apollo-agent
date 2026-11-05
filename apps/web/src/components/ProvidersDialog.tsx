import type { ClaudeAuth, LlamaCppMode, ModelOption, ProviderSettings, UpdateProviderSettingsInput } from "@apollo/contracts";
import { useEffect, useState } from "react";
import { forgetModels } from "../models.ts";
import { errorMessage, rpc } from "../rpc.ts";
import { setLocalModels, useApp } from "../store.ts";
import { Button, cx, Field, inputClass, Modal } from "./ui.tsx";

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

/** Credentials and endpoints for the providers. Changes apply to sessions started afterwards. */
function Choice<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<readonly [T, string, string]>;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map(([option, name, detail]) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={cx(
            "rounded-md border px-3 py-2 text-left text-sm",
            value === option
              ? "border-zinc-400 bg-zinc-800 text-zinc-100"
              : "border-zinc-800 text-zinc-400 hover:border-zinc-700",
          )}
        >
          <div className="font-medium">{name}</div>
          <div className="text-[11px] text-zinc-500">{detail}</div>
        </button>
      ))}
    </div>
  );
}

/** One line on the managed llama.cpp setup. */
function ManagedSummary() {
  const state = useApp((s) => s.localModels);
  useEffect(() => {
    void rpc((c) => c["localModels.state"]()).then(setLocalModels);
  }, []);
  if (!state) return <span className="text-zinc-500">Checking…</span>;
  if (!state.engine.installed) return <span className="text-zinc-400">llama.cpp is not installed yet.</span>;
  const ready = state.models.filter((m) => m.status !== "downloading").length;
  return (
    <span className="text-zinc-400">
      llama.cpp {state.engine.installed.tag} · {ready === 0 ? "no models yet" : `${ready} model${ready === 1 ? "" : "s"}`} · server{" "}
      {state.server.status}
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
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Claude Code</h3>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["subscription", "Claude login", "Your claude login: subscription or Console"],
                  ["api-key", "API key", "Billed to the key's Console account"],
                ] as const
              ).map(([value, name, detail]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setAuth(value)}
                  className={cx(
                    "rounded-md border px-3 py-2 text-left text-sm",
                    auth === value
                      ? "border-zinc-400 bg-zinc-800 text-zinc-100"
                      : "border-zinc-800 text-zinc-400 hover:border-zinc-700",
                  )}
                >
                  <div className="font-medium">{name}</div>
                  <div className="text-[11px] text-zinc-500">{detail}</div>
                </button>
              ))}
            </div>
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
          </section>

          <section className="space-y-3 border-t border-zinc-800 pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">llama.cpp</h3>
            <Choice
              value={mode}
              onChange={setMode}
              options={[
                ["managed", "Managed by Apollo", "Installs, runs and updates llama-server"],
                ["external", "My own server", "A llama-server you run yourself"],
              ]}
            />
            <p className="text-[11px] text-zinc-500">
              Local models run with the Claude Code harness through llama-server's Anthropic-compatible API: tools, MCP,
              skills and approvals work as with Claude. Agents need a model that is good at calling tools.
            </p>
            {mode === "managed" ? (
              <div className="flex items-center gap-3 rounded-md border border-zinc-800 p-3 text-xs">
                <span className="min-w-0 flex-1">
                  <ManagedSummary />
                </span>
                <Button onClick={() => run(() => save().then(onLocalModels))} disabled={saving}>
                  Local models…
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
                  <Button variant="ghost" disabled={saving} onClick={testLlama}>
                    Save and test
                  </Button>
                  <span className="min-w-0 text-[11px]">
                    {check.status === "checking" ? <span className="text-zinc-500">Connecting…</span> : null}
                    {check.status === "ok" ? (
                      <span className="text-emerald-400">
                        Connected:{" "}
                        {check.models.length === 0 ? "no model loaded" : check.models.map((m) => m.label).join(", ")}
                      </span>
                    ) : null}
                    {check.status === "error" ? <span className="text-red-400">{check.error}</span> : null}
                  </span>
                </div>
              </>
            )}
          </section>
          <p className="text-[11px] text-zinc-500">Changes apply to sessions that start after you save.</p>
        </>
      ) : (
        <p className="text-sm text-zinc-500">Loading…</p>
      )}
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
    </Modal>
  );
}
