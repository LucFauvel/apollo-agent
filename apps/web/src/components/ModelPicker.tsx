import { isDownloaded, type ProviderKind } from "@apollo/contracts";
import { effectiveModel, useModels } from "../models.ts";
import { useApp } from "../store.ts";
import { downloadPercent, splitModelId } from "./LocalModelsDialog.tsx";
import { cx, inputClass } from "./ui.tsx";

export interface ModelChoice {
  readonly model: string | null;
  readonly effort: string | null;
}

const CUSTOM = "__custom__";

const effortLabel = (effort: string) => effort.charAt(0).toUpperCase() + effort.slice(1);

/**
 * Model and reasoning effort for one provider, from the models its CLI reports.
 * `null` means "the provider's default". If the list cannot be loaded, the
 * model becomes a free-text field.
 */
export function ModelPicker({
  provider,
  value,
  onChange,
  quietErrors = false,
}: {
  provider: ProviderKind;
  value: ModelChoice;
  onChange: (value: ModelChoice) => void;
  /** Hide "could not list models" (e.g. when setup is shown right below). */
  quietErrors?: boolean;
}) {
  const state = useModels(provider);
  // Local models still downloading can be picked already; sessions wait for them.
  const localModels = useApp((s) => (provider === "llamacpp" ? s.localModels : null));
  const downloading = localModels?.models.filter((m) => !isDownloaded(m)) ?? [];

  if (state.status !== "ready" && downloading.length === 0) {
    return (
      <div className="space-y-1">
        <input
          className={inputClass}
          value={value.model ?? ""}
          disabled={state.status === "loading"}
          onChange={(e) => onChange({ model: e.target.value.trim() || null, effort: value.effort })}
          placeholder={state.status === "loading" ? "Loading models…" : "Provider default"}
        />
        {state.status === "error" && !quietErrors ? (
          <div className="text-[11px] text-zinc-500">Could not list models ({state.error}). Type a model id, or leave empty.</div>
        ) : null}
      </div>
    );
  }

  const models = state.status === "ready" ? state.models : [];
  const pending = downloading.filter((d) => !models.some((m) => m.id === d.id));
  const known = value.model === null || models.some((m) => m.id === value.model) || pending.some((m) => m.id === value.model);
  const fallback = models.find((m) => m.isDefault);
  const current = effectiveModel(models, value.model);
  const efforts = current?.efforts ?? [];

  const pickModel = (id: string) => {
    if (id === CUSTOM) return onChange({ model: value.model ?? "", effort: value.effort });
    const model = id === "" ? null : id;
    const next = effectiveModel(models, model);
    // Keep the effort only if the new model supports it.
    const effort = value.effort !== null && next?.efforts.includes(value.effort) ? value.effort : null;
    onChange({ model, effort });
  };

  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <select
          className={inputClass}
          value={known ? (value.model ?? "") : CUSTOM}
          onChange={(e) => pickModel(e.target.value)}
        >
          <option value="">Default{fallback ? ` (${fallback.label})` : ""}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id} title={m.description}>
              {m.label}
            </option>
          ))}
          {pending.map((m) => {
            const { name, quant } = splitModelId(m.id);
            return (
              <option key={m.id} value={m.id}>
                {name} {quant ?? ""} · downloading {downloadPercent(m)}%
              </option>
            );
          })}
          <option value={CUSTOM}>Other…</option>
        </select>
        {!known ? (
          <input
            className={cx(inputClass, "font-mono text-xs")}
            value={value.model ?? ""}
            onChange={(e) => onChange({ model: e.target.value, effort: value.effort })}
            placeholder="model id"
            autoFocus
          />
        ) : current?.description ? (
          <div className="truncate text-[11px] text-zinc-500" title={current.description}>
            {current.description}
          </div>
        ) : null}
      </div>
      {efforts.length > 0 || value.effort !== null ? (
        <div className="w-36 shrink-0">
          <select
            className={inputClass}
            value={value.effort ?? ""}
            onChange={(e) => onChange({ model: value.model, effort: e.target.value || null })}
            title="Reasoning effort"
          >
            <option value="">Effort: {current?.defaultEffort ? effortLabel(current.defaultEffort) : "default"}</option>
            {[...new Set([...efforts, ...(value.effort ? [value.effort] : [])])].map((e) => (
              <option key={e} value={e}>
                {effortLabel(e)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}
