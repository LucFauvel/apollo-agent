import { isDownloaded, type ProviderKind, type Session } from "@apollo/contracts";
import { Check, ChevronDown, Settings2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { effectiveModel, useModels } from "../models.ts";
import { errorMessage, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";
import { downloadPercent, splitModelId } from "./LocalModelsDialog.tsx";
import { cx, inputClass, ModelChip, providerName } from "./ui.tsx";

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

/**
 * The model indicator in the message box, which is also the session's model
 * and effort menu. A pick applies from the next message.
 */
export function ModelMenu({
  session,
  label,
  onMoreSettings,
}: {
  session: Session;
  label: string | null;
  onMoreSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const state = useModels(session.provider);
  const localModels = useApp((s) => (session.provider === "llamacpp" ? s.localModels : null));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const models = state.status === "ready" ? state.models : [];
  const pending = (localModels?.models ?? []).filter((d) => !isDownloaded(d) && !models.some((m) => m.id === d.id));
  const current = effectiveModel(models, session.model);
  const efforts = [...new Set([...(current?.efforts ?? []), ...(session.effort ? [session.effort] : [])])];
  const fallback = models.find((m) => m.isDefault);

  const update = (choice: ModelChoice) => {
    setError(null);
    rpc((c) => c["sessions.update"]({ sessionId: session.id, model: choice.model, effort: choice.effort })).catch((e) =>
      setError(errorMessage(e)),
    );
  };
  const pickModel = (model: string | null) => {
    const next = effectiveModel(models, model);
    const effort = session.effort !== null && next?.efforts.includes(session.effort) ? session.effort : null;
    update({ model, effort });
  };

  const row = (key: string, selected: boolean, onSelect: () => void, children: ReactNode, title?: string) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      title={title}
      onClick={onSelect}
      className={cx(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
        selected ? "bg-zinc-800/70 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected ? <Check className="size-3.5 shrink-0 text-zinc-400" /> : null}
    </button>
  );

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx(
          "group flex min-w-0 items-center rounded-md transition-[background-color,box-shadow,color] duration-200",
          "hover:bg-white/[0.04] hover:shadow-[0_0_12px_rgba(255,255,255,0.08)] focus-visible:ring-1 focus-visible:ring-zinc-600 focus-visible:outline-none",
          open && "bg-white/[0.04] shadow-[0_0_12px_rgba(255,255,255,0.08)]",
        )}
      >
        <ModelChip
          provider={session.provider}
          model={label ?? providerName(session.provider)}
          effort={session.effort}
          className="px-1.5 text-zinc-500"
        />
        <ChevronDown
          className={cx(
            "h-3 shrink-0 text-zinc-500 transition-all duration-200",
            open ? "mr-1 w-3 rotate-180 opacity-100" : "w-0 opacity-0 group-hover:mr-1 group-hover:w-3 group-hover:opacity-100 group-focus-visible:mr-1 group-focus-visible:w-3 group-focus-visible:opacity-100",
          )}
        />
      </button>
      {open ? (
        <div
          role="menu"
          className="animate-pop-in absolute bottom-full left-0 z-40 mb-2 w-72 rounded-xl border border-zinc-800 bg-zinc-900 p-1 shadow-xl shadow-black/40"
        >
          <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-zinc-500">{providerName(session.provider)} model</div>
          <div className="max-h-72 overflow-y-auto">
            {state.status === "loading" ? (
              <div className="px-2.5 py-1.5 text-[13px] text-zinc-500">Loading models…</div>
            ) : state.status === "error" && pending.length === 0 ? (
              <div className="px-2.5 py-1.5 text-[12px] text-zinc-500">Could not list models ({state.error}).</div>
            ) : (
              <>
                {row("default", session.model === null, () => pickModel(null), `Default${fallback ? ` (${fallback.label})` : ""}`)}
                {models.map((m) => row(m.id, session.model === m.id, () => pickModel(m.id), m.label, m.description || undefined))}
                {pending.map((m) => {
                  const { name, quant } = splitModelId(m.id);
                  return row(
                    m.id,
                    session.model === m.id,
                    () => pickModel(m.id),
                    <>
                      {name} {quant ?? ""} <span className="text-zinc-500">· downloading {downloadPercent(m)}%</span>
                    </>,
                  );
                })}
                {session.model !== null && !models.some((m) => m.id === session.model) && !pending.some((m) => m.id === session.model)
                  ? row(session.model, true, () => setOpen(false), <span className="font-mono text-xs">{session.model}</span>)
                  : null}
              </>
            )}
          </div>
          {efforts.length > 0 ? (
            <>
              <div className="mx-1 my-1 border-t border-zinc-800" />
              <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-zinc-500">Effort</div>
              <div className="flex flex-wrap gap-1 px-1.5 pb-1.5">
                {[null, ...efforts].map((e) => {
                  const selected = session.effort === e;
                  return (
                    <button
                      key={e ?? "default"}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      onClick={() => update({ model: session.model, effort: e })}
                      className={cx(
                        "rounded-md border px-2 py-0.5 text-[12px]",
                        selected
                          ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                          : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
                      )}
                    >
                      {e === null ? `Default${current?.defaultEffort ? ` (${effortLabel(current.defaultEffort)})` : ""}` : effortLabel(e)}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
          {error ? <div className="px-2.5 py-1 text-[11px] text-red-400">{error}</div> : null}
          <div className="mx-1 my-1 border-t border-zinc-800" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onMoreSettings();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Settings2 className="size-3.5 shrink-0 opacity-80" />
            Other model, permissions…
          </button>
        </div>
      ) : null}
    </div>
  );
}
