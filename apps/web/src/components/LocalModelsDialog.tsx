import {
  isDownloaded,
  type LlamaBackend,
  type LocalModel,
  type LocalModelsState,
  type ModelCandidate,
  type ModelDetails,
  type ModelFit,
  type QuantOption,
  type SuggestedModel,
} from "@apollo/contracts";
import { useEffect, useState } from "react";
import { forgetModels } from "../models.ts";
import { errorMessage, rpc } from "../rpc.ts";
import { setLocalModels, useApp } from "../store.ts";
import { Cpu } from "lucide-react";
import { LlamaLogo } from "./icons.tsx";
import { Button, cx, ErrorText, inputClass, Modal } from "./ui.tsx";

const GB = 1024 ** 3;
export const formatBytes = (bytes: number) =>
  bytes >= GB ? `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB` : `${Math.max(bytes / 1024 ** 2, 1).toFixed(0)} MB`;
const formatParams = (n: number | null) => (n === null ? null : n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : `${Math.round(n / 1e6)}M`);
const formatCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const formatContext = (n: number) => `${Math.round(n / 1024)}K context`;

/** Starts a stopped download again; llama.cpp continues from the partial files. */
const resumeDownload = (id: string) => {
  const [repo, quant] = id.split(/:(?=[^/]+$)/);
  return rpc((c) => c["localModels.download"]({ repo: repo!, quant: quant ?? "" }));
};

/** Download progress of a local model, 0-100. */
export const downloadPercent = (model: LocalModel) =>
  model.download && model.download.total > 0 ? Math.floor((model.download.done / model.download.total) * 100) : 0;

/**
 * The download a llama.cpp session must wait for: its model, or (with no model
 * chosen and none ready yet) the first one downloading. `null` when it can run.
 */
export const blockingDownload = (state: LocalModelsState | null, model: string | null): LocalModel | null => {
  if (!state) return null;
  const unfinished = state.models.filter((m) => !isDownloaded(m));
  if (model) return unfinished.find((m) => m.id === model) ?? null;
  return state.models.some(isDownloaded) ? null : (unfinished.find((m) => m.status === "downloading") ?? unfinished[0] ?? null);
};

/** Loads the local models state once, if nothing has yet; it stays current through app changes. */
export const useLocalModels = (enabled = true) => {
  const state = useApp((s) => s.localModels);
  useEffect(() => {
    if (enabled && !state) void rpc((c) => c["localModels.state"]()).then(setLocalModels, () => undefined);
  }, [enabled, state === null]);
  return state;
};

/** A model download in progress, as a card (e.g. in a conversation waiting for it). */
export function DownloadProgress({ model }: { model: LocalModel }) {
  const { name, quant } = splitModelId(model.id);
  const download = model.download;
  return (
    <div className="animate-fade-up space-y-2 rounded-xl border border-sky-500/25 bg-gradient-to-b from-sky-950/30 to-zinc-950 p-3.5">
      <div className="flex items-center gap-2.5 text-xs">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10">
          <LlamaLogo size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-100">
            {model.status === "incomplete" ? "Download stopped:" : "Downloading"} {name} {quant ? <span className="font-mono text-[11px] text-zinc-500">{quant}</span> : null}
          </div>
          <div className="text-zinc-500">The conversation starts once the model is on this machine.</div>
        </div>
        {model.status === "incomplete" ? (
          <Button size="sm" variant="primary" onClick={() => void resumeDownload(model.id)}>
            Resume
          </Button>
        ) : (
          <span className="shrink-0 font-mono text-sm text-sky-200 tabular-nums">{downloadPercent(model)}%</span>
        )}
      </div>
      <Bar done={download?.done ?? 0} total={download?.total ?? 0} />
      <div className="flex justify-between text-[11px] text-zinc-500">
        <span>
          {download && download.total > 0 ? `${formatBytes(download.done)} of ${formatBytes(download.total)}` : "Starting…"}
        </span>
        <span>If you quit Apollo, it picks up where it left off next time.</span>
      </div>
    </div>
  );
}

/** A local model being loaded into memory, shown while a conversation waits for it. */
export function LoadProgress({ model }: { model: LocalModel }) {
  const { name, quant } = splitModelId(model.id);
  const percent = Math.floor((model.loadProgress ?? 0) * 100);
  return (
    <div className="animate-fade-up flex items-center gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5 text-xs">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80">
        <LlamaLogo size={14} />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="shimmer-text min-w-0 flex-1 truncate">
            Loading {name}
            {quant ? ` ${quant}` : ""} into memory
          </span>
          <span className="shrink-0 font-mono text-[11px] text-zinc-400 tabular-nums">{percent}%</span>
        </div>
        <Bar done={percent} total={100} />
      </div>
    </div>
  );
}

/** `unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M` → name and quant. */
export const splitModelId = (id: string) => {
  const [repo, quant] = id.split(/:(?=[^/]+$)/);
  return { name: repo!.split("/").pop()!.replace(/[-_.]?GGUF$/i, ""), author: repo!.split("/")[0]!, quant: quant ?? null };
};

const BACKENDS: ReadonlyArray<{ value: LlamaBackend; label: string }> = [
  { value: "cuda", label: "CUDA (NVIDIA)" },
  { value: "vulkan", label: "Vulkan (any GPU)" },
  { value: "rocm", label: "ROCm (AMD)" },
  { value: "metal", label: "Metal (Apple)" },
  { value: "cpu", label: "CPU only" },
];
const backendLabel = (backend: LlamaBackend) => BACKENDS.find((b) => b.value === backend)?.label ?? backend;

const FIT: Record<ModelFit, { label: string; className: string; title: string }> = {
  gpu: { label: "Fits your GPU", className: "text-emerald-300 bg-emerald-500/10 ring-emerald-500/20", title: "Runs entirely in GPU memory" },
  ram: { label: "Uses system RAM", className: "text-amber-300 bg-amber-500/10 ring-amber-500/20", title: "Works, but slower: part of it runs from system RAM" },
  "too-big": { label: "Too big", className: "text-red-300 bg-red-500/10 ring-red-500/20", title: "Does not fit in this machine's memory" },
};

function FitBadge({ fit }: { fit: ModelFit }) {
  const { label, className, title } = FIT[fit];
  return (
    <span title={title} className={cx("shrink-0 rounded-md px-1.5 py-px text-[10px] font-medium ring-1 ring-inset", className)}>
      {label}
    </span>
  );
}

function Bar({ done, total }: { done: number; total: number }) {
  const ratio = total > 0 ? Math.min(done / total, 1) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
      <div className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-500 transition-[width]" style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Engine and server
// ---------------------------------------------------------------------------

function EngineSection({ state, act }: { state: LocalModelsState; act: (f: () => Promise<unknown>) => void }) {
  const { engine } = state;
  const [backend, setBackend] = useState<LlamaBackend>(engine.installed?.backend ?? "auto");
  const install = () => act(() => rpc((c) => c["localModels.installEngine"]({ backend })));
  const update =
    engine.installed && engine.latestTag && engine.latestTag !== engine.installed.tag ? engine.latestTag : null;

  return (
    <Section title="llama.cpp">
      {engine.installing ? (
        <div className="space-y-1.5 rounded-xl border border-zinc-800/80 p-3">
          <div className="flex justify-between text-xs text-zinc-300">
            <span className="truncate">{engine.installing.step}</span>
            {engine.installing.progress.total > 0 ? (
              <span className="shrink-0 text-zinc-500">
                {formatBytes(engine.installing.progress.done)} / {formatBytes(engine.installing.progress.total)}
              </span>
            ) : null}
          </div>
          <Bar {...engine.installing.progress} />
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-zinc-800/80 p-3">
          <div className="min-w-0 flex-1 text-xs">
            {engine.installed ? (
              <>
                <div className="text-zinc-200">
                  Installed <span className="font-mono">{engine.installed.tag}</span> · {backendLabel(engine.installed.backend)}
                </div>
                <div className="text-zinc-500">{update ? `${update} is available.` : "Up to date."}</div>
              </>
            ) : (
              <>
                <div className="text-zinc-200">Not installed</div>
                <div className="text-zinc-500">
                  Apollo downloads the official build for your hardware and checks it against its published checksum.
                </div>
              </>
            )}
          </div>
          <div className="w-48 shrink-0">
            <select
              className={inputClass}
              value={backend}
              onChange={(e) => setBackend(e.target.value as LlamaBackend)}
              title="Which llama.cpp build to install"
            >
              <option value="auto">Auto ({backendLabel(engine.recommendedBackend)})</option>
              {BACKENDS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          <Button variant={engine.installed ? "secondary" : "primary"} onClick={install}>
            {!engine.installed ? "Install" : update ? `Update to ${update}` : "Reinstall"}
          </Button>
        </div>
      )}
      {engine.error ? <p className="text-xs text-red-400">{engine.error}</p> : null}
    </Section>
  );
}

function ServerSection({ state, act }: { state: LocalModelsState; act: (f: () => Promise<unknown>) => void }) {
  const [logs, setLogs] = useState<ReadonlyArray<string> | null>(null);
  const { status, error } = state.server;

  useEffect(() => {
    if (logs === null) return;
    const timer = setInterval(() => void rpc((c) => c["localModels.logs"]()).then(setLogs), 2000);
    return () => clearInterval(timer);
  }, [logs === null]);

  if (!state.engine.installed) return null;
  const dot = { running: "bg-emerald-500", starting: "bg-amber-500 animate-pulse", stopped: "bg-zinc-600", error: "bg-red-500" }[status];
  return (
    <Section
      title="Server"
      aside={
        <button
          className="text-[11px] text-zinc-500 hover:text-zinc-200"
          onClick={() => (logs ? setLogs(null) : void rpc((c) => c["localModels.logs"]()).then(setLogs))}
        >
          {logs ? "Hide log" : "Show log"}
        </button>
      }
    >
      <div className="flex items-center gap-2 rounded-xl border border-zinc-800/80 p-3 text-xs">
        <span className={cx("size-2 shrink-0 rounded-full", dot)} />
        <span className="min-w-0 flex-1 text-zinc-300">
          {status === "running"
            ? "Running. Models load on first use and unload after 15 idle minutes."
            : status === "starting"
              ? "Starting…"
              : status === "error"
                ? <span className="text-red-400">{error}</span>
                : "Stopped. It starts by itself when a session needs it."}
        </span>
        {status === "running" || status === "starting" ? (
          <Button size="sm" variant="ghost" onClick={() => act(() => rpc((c) => c["localModels.stopServer"]()))}>
            Stop
          </Button>
        ) : (
          <Button size="sm" onClick={() => act(() => rpc((c) => c["localModels.startServer"]()))}>
            Start
          </Button>
        )}
      </div>
      {logs ? (
        <pre className="max-h-48 overflow-auto rounded-md bg-black/60 p-2 font-mono text-[10px] leading-relaxed text-zinc-400">
          {logs.slice(-150).join("\n") || "No output yet."}
        </pre>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<LocalModel["status"], string> = {
  unloaded: "Ready",
  loading: "Loading…",
  loaded: "Loaded",
  sleeping: "Idle (unloaded)",
  downloading: "Downloading",
  incomplete: "Download stopped",
  failed: "Failed to load",
};

function LibraryRow({
  model,
  isDefault,
  act,
}: {
  model: LocalModel;
  isDefault: boolean;
  act: (f: () => Promise<unknown>) => void;
}) {
  const { name, quant } = splitModelId(model.id);
  return (
    <div className="space-y-1.5 px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 truncate text-zinc-100" title={model.id}>
          {name}
        </span>
        {quant ? <span className="shrink-0 font-mono text-[10px] text-zinc-500">{quant}</span> : null}
        {isDefault ? <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-300">default</span> : null}
        <span className="flex-1" />
        {model.fit ? <FitBadge fit={model.fit} /> : null}
        <span className={cx("shrink-0 text-[11px]", model.status === "failed" ? "text-red-400" : "text-zinc-500")}>
          {STATUS_LABEL[model.status]}
        </span>
        {model.status === "incomplete" ? (
          <>
            <Button size="sm" onClick={() => act(() => resumeDownload(model.id))}>
              Resume
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                confirm(`Delete the partial download of ${name}${quant ? ` (${quant})` : ""}?`) &&
                act(() => rpc((c) => c["localModels.delete"]({ model: model.id })).then(forgetModels))
              }
            >
              Delete
            </Button>
          </>
        ) : model.status === "downloading" ? (
          <Button size="sm" variant="ghost" onClick={() => act(() => rpc((c) => c["localModels.cancelDownload"]({ model: model.id })))}>
            Cancel
          </Button>
        ) : (
          <>
            {!isDefault ? (
              <Button size="sm" variant="ghost" onClick={() => act(() => rpc((c) => c["localModels.setDefault"]({ model: model.id })))}>
                Make default
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                confirm(`Delete ${name}${quant ? ` (${quant})` : ""} from this machine?`) &&
                act(() => rpc((c) => c["localModels.delete"]({ model: model.id })).then(forgetModels))
              }
            >
              Delete
            </Button>
          </>
        )}
      </div>
      {model.download ? (
        <div className="flex items-center gap-2">
          <Bar {...model.download} />
          <span className="shrink-0 text-[10px] text-zinc-500">
            {model.download.total > 0 ? `${formatBytes(model.download.done)} / ${formatBytes(model.download.total)}` : "Starting…"}
          </span>
        </div>
      ) : model.sizeBytes || model.contextSize ? (
        <div className="text-[11px] text-zinc-500">
          {[model.sizeBytes ? formatBytes(model.sizeBytes) : null, model.contextSize ? formatContext(model.contextSize) : null]
            .filter(Boolean)
            .join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function QuantTable({
  details,
  installed,
  onDownload,
}: {
  details: ModelDetails;
  installed: ReadonlySet<string>;
  onDownload: (quant: QuantOption) => void;
}) {
  return (
    <div className="space-y-1 rounded-md bg-zinc-900/60 p-2">
      <div className="px-1 text-[10px] text-zinc-500">
        Memory at {formatContext(details.contextSize)}, with an 8-bit KV cache. Below 4-bit, quality drops too far.
      </div>
      {details.quants.map((q) => {
        const id = `${details.candidate.repo}:${q.quant}`;
        return (
          <div key={q.quant} className={cx("flex items-center gap-2 rounded px-1 py-0.5 text-[11px]", q.bits < 4 && "opacity-50")}>
            <span className="w-28 shrink-0 font-mono text-zinc-200">{q.quant}</span>
            {q.quant === details.bestQuant ? <span className="shrink-0 text-[10px] text-sky-300">best fit</span> : null}
            <span className="flex-1" />
            <span className="w-16 shrink-0 text-right text-zinc-500">{formatBytes(q.sizeBytes)}</span>
            <span className="w-24 shrink-0 text-right text-zinc-500" title="Weights + KV cache + buffers">
              needs {formatBytes(q.memoryBytes)}
            </span>
            <span className="w-28 shrink-0 text-right">
              <FitBadge fit={q.fit} />
            </span>
            <Button size="sm" variant="ghost" disabled={installed.has(id) || q.fit === "too-big"} onClick={() => onDownload(q)}>
              {installed.has(id) ? "Added" : "Download"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function CandidateRow({
  candidate,
  details: initial,
  recommended = false,
  installed,
  act,
  onDownload,
}: {
  candidate: ModelCandidate;
  details?: ModelDetails;
  recommended?: boolean;
  installed: ReadonlySet<string>;
  act: (f: () => Promise<unknown>) => void;
  onDownload?: ((id: string) => void) | undefined;
}) {
  const [details, setDetails] = useState<ModelDetails | null>(initial ?? null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const best = details?.quants.find((q) => q.quant === details.bestQuant) ?? null;

  const load = () => {
    if (details) return setOpen(!open);
    setLoading(true);
    rpc((c) => c["localModels.details"]({ repo: candidate.repo }))
      .then((d) => (setDetails(d), setOpen(true)))
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  };
  const download = (quant: string) =>
    act(() =>
      rpc((c) => c["localModels.download"]({ repo: candidate.repo, quant })).then(() =>
        onDownload?.(`${candidate.repo}:${quant}`),
      ),
    );

  return (
    <div className="space-y-1.5 px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {recommended ? <span className="text-amber-300" title="Recommended for this machine">★</span> : null}
            <span className="truncate text-zinc-100">{candidate.name}</span>
            {candidate.vision ? <span className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">vision</span> : null}
          </div>
          <div className="truncate text-[11px] text-zinc-500">
            {[
              candidate.author,
              formatParams(candidate.parameters),
              `${formatCount(candidate.downloads)} downloads`,
              best ? `${best.quant} · ${formatBytes(best.sizeBytes)}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        {best ? <FitBadge fit={best.fit} /> : details ? <FitBadge fit="too-big" /> : null}
        <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
          {loading ? "Sizing…" : open ? "Hide builds" : details ? "Other builds" : "Check fit"}
        </Button>
        {best ? (
          <Button
            size="sm"
            variant={recommended ? "primary" : "secondary"}
            disabled={installed.has(`${candidate.repo}:${best.quant}`)}
            onClick={() => download(best.quant)}
          >
            {installed.has(`${candidate.repo}:${best.quant}`) ? "Added" : "Download"}
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
      {details?.note && open ? <p className="text-[11px] text-zinc-500">{details.note}</p> : null}
      {open && details ? <QuantTable details={details} installed={installed} onDownload={(q) => download(q.quant)} /> : null}
    </div>
  );
}

function FindModels({
  installed,
  act,
  onDownload,
  compact = false,
}: {
  installed: ReadonlySet<string>;
  act: (f: () => Promise<unknown>) => void;
  onDownload?: ((id: string) => void) | undefined;
  compact?: boolean;
}) {
  const [suggested, setSuggested] = useState<ReadonlyArray<SuggestedModel> | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<ModelCandidate> | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc((c) => c["localModels.suggested"]())
      .then(setSuggested)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return setResults(null);
    setSearching(true);
    const timer = setTimeout(() => {
      rpc((c) => c["localModels.search"]({ query: text }))
        .then(setResults)
        .catch((e) => setError(errorMessage(e)))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <Section title="Find models">
      <input
        className={inputClass}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search all GGUF models on Hugging Face (e.g. qwen coder, gemma)"
      />
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      <div className={cx("divide-y divide-zinc-800/70 rounded-xl border border-zinc-800/80", compact && "max-h-72 overflow-y-auto")}>
        {results ? (
          results.length === 0 ? (
            <p className="p-3 text-xs text-zinc-500">{searching ? "Searching…" : "No GGUF chat models match."}</p>
          ) : (
            results.map((candidate) => (
              <CandidateRow key={candidate.repo} candidate={candidate} installed={installed} act={act} onDownload={onDownload} />
            ))
          )
        ) : suggested === null ? (
          <p className="p-3 text-xs text-zinc-500">Sizing popular models for this machine…</p>
        ) : suggested.length === 0 ? (
          <p className="p-3 text-xs text-zinc-500">No suggestions available. Search instead.</p>
        ) : (
          suggested.map(({ details, recommended }) => (
            <CandidateRow
              key={details.candidate.repo}
              candidate={details.candidate}
              details={details}
              recommended={recommended}
              installed={installed}
              act={act}
              onDownload={onDownload}
            />
          ))
        )}
      </div>
      <p className="text-[11px] text-zinc-500">
        Suggestions are the most downloaded models from ggml-org, unsloth, bartowski and LM Studio, sized for this
        machine. Agents need a model that is good at calling tools.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------

const hardwareSummary = (state: LocalModelsState) => {
  const { hardware } = state;
  const gpus = hardware.gpus.map((g) => (g.memoryBytes > 0 ? `${g.name} · ${formatBytes(g.memoryBytes)}${g.unified ? " shared" : ""}` : g.name));
  return [...(gpus.length ? gpus : ["No GPU found"]), `${formatBytes(hardware.ramBytes)} RAM`].join(" · ");
};

const RECOMMENDED_REVIEWER = "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M";

/**
 * The small model that reviews tool calls in auto mode on local models, when Apollo's
 * rules cannot tell whether a call is safe (connector actions, edits outside the workspace).
 */
function ReviewerSection({ state, act }: { state: LocalModelsState; act: (f: () => Promise<unknown>) => void }) {
  const ready = state.models.filter(isDownloaded);
  const current = state.models.find((m) => m.id === state.reviewerModel) ?? null;
  const recommendedPresent = state.models.some((m) => m.id === RECOMMENDED_REVIEWER);
  return (
    <Section title="Auto mode reviewer">
      <div className="space-y-2 rounded-xl border border-zinc-800/80 p-3">
        <p className="text-xs leading-relaxed text-zinc-500">
          In auto mode, local models get their tool calls checked by Apollo's rules. Calls the rules cannot settle, such as
          connector actions that send or change things, or edits outside the workspace, go to this small model, which
          allows them or asks you. Without one, Apollo asks you.
        </p>
        <div className="flex items-center gap-2">
          <select
            className={inputClass}
            value={state.reviewerModel ?? ""}
            onChange={(e) => act(() => rpc((c) => c["localModels.setReviewer"]({ model: e.target.value || null })))}
          >
            <option value="">None: rules only, ask about the rest</option>
            {ready.map((m) => {
              const { name, quant } = splitModelId(m.id);
              return (
                <option key={m.id} value={m.id}>
                  {name} {quant ?? ""}
                </option>
              );
            })}
            {current && !isDownloaded(current) ? (
              <option value={current.id}>
                {splitModelId(current.id).name} (downloading {downloadPercent(current)}%)
              </option>
            ) : null}
          </select>
          {!recommendedPresent ? (
            <Button className="shrink-0" onClick={() => act(() => rpc((c) => c["localModels.installReviewer"]()))}>
              Get Qwen3 4B (2.5 GB)
            </Button>
          ) : null}
        </div>
        {current && !isDownloaded(current) ? (
          <p className="text-[11px] text-zinc-500">Apollo asks you until the reviewer has finished downloading.</p>
        ) : null}
      </div>
    </Section>
  );
}

/** Install llama.cpp, run its server, and find, download and manage local models. */
export function LocalModelsDialog({ onClose }: { onClose: () => void }) {
  const state = useApp((s) => s.localModels);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc((c) => c["localModels.state"]())
      .then(setLocalModels)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const act = (f: () => Promise<unknown>) => {
    setError(null);
    f().catch((e) => setError(errorMessage(e)));
  };

  // New models change what the llama.cpp provider offers.
  const ready = state?.models.filter(isDownloaded).length ?? 0;
  useEffect(() => forgetModels(), [ready]);

  const installed = new Set(state?.models.map((m) => m.id) ?? []);
  return (
    <Modal
      wide
      title="Local models"
      description={
        state ? (
          <span className="flex items-center gap-1.5">
            <Cpu className="size-3" /> {hardwareSummary(state)}
          </span>
        ) : (
          "llama.cpp, managed by Apollo"
        )
      }
      icon={
        <span className="flex size-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
          <LlamaLogo size={20} />
        </span>
      }
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      {state ? (
        <>
          <EngineSection state={state} act={act} />
          <ServerSection state={state} act={act} />
          {state.engine.installed ? (
            <>
              <Section title="Your models">
                <div className="divide-y divide-zinc-800/70 rounded-xl border border-zinc-800/80">
                  {state.models.length === 0 ? (
                    <p className="p-3 text-xs text-zinc-500">No models yet. Pick one below.</p>
                  ) : (
                    state.models.map((model) => (
                      <LibraryRow
                        key={model.id}
                        model={model}
                        isDefault={model.id === (state.defaultModel ?? state.models.find(isDownloaded)?.id)}
                        act={act}
                      />
                    ))
                  )}
                </div>
              </Section>
              <ReviewerSection state={state} act={act} />
              <FindModels installed={installed} act={act} />
            </>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-zinc-500">Loading…</p>
      )}
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}

/**
 * Inline llama.cpp setup for pickers (e.g. the new bot dialog): install the engine,
 * follow downloads, and find models with the same lookup as the Local models dialog.
 * A model downloaded from here is picked right away (`onSelect`); sessions wait for it.
 */
export function LocalModelSetup({ onSelect }: { onSelect: (id: string) => void }) {
  const state = useApp((s) => s.localModels);
  const [external, setExternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = state?.models.filter(isDownloaded) ?? [];
  const downloading = state?.models.filter((m) => !isDownloaded(m)) ?? [];
  const [finding, setFinding] = useState<boolean | null>(null);
  const showFinder = finding ?? ready.length === 0;

  useEffect(() => {
    rpc((c) => c["localModels.state"]())
      .then(setLocalModels)
      .catch((e) => setError(errorMessage(e)));
    rpc((c) => c["providers.settings"]())
      .then((s) => setExternal(s.llamacpp.mode === "external"))
      .catch(() => undefined);
  }, []);

  // A finished download (or a new engine) changes what the provider offers.
  const engineTag = state?.engine.installed?.tag;
  useEffect(() => forgetModels(), [ready.length, engineTag, state?.server.status]);

  const act = (f: () => Promise<unknown>) => {
    setError(null);
    f().catch((e) => setError(errorMessage(e)));
  };

  if (external) return null;
  if (!state) return <p className="text-xs text-zinc-500">Checking local models…</p>;

  const installed = new Set(state.models.map((m) => m.id));
  return (
    <div className="animate-fade-up space-y-3 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3">
      {!state.engine.installed || state.engine.installing ? (
        <EngineSection state={state} act={act} />
      ) : (
        <>
          <div className="flex items-center gap-2 text-xs">
            <LlamaLogo size={14} />
            <span className="flex-1 text-zinc-400">
              {ready.length === 0
                ? "No local models yet. Download one to use llama.cpp."
                : `${ready.length} local model${ready.length === 1 ? "" : "s"} on this machine.`}
            </span>
            {ready.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => setFinding(!showFinder)}>
                {showFinder ? "Hide" : "Download more"}
              </Button>
            ) : null}
          </div>
          {downloading.length > 0 ? (
            <div className="divide-y divide-zinc-800/70 rounded-xl border border-zinc-800/80">
              {downloading.map((model) => (
                <LibraryRow key={model.id} model={model} isDefault={false} act={act} />
              ))}
            </div>
          ) : null}
          {showFinder ? (
            <FindModels
              installed={installed}
              act={act}
              compact
              onDownload={onSelect}
            />
          ) : null}
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
