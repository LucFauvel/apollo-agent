import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { arch, platform, totalmem } from "node:os";
import { join } from "node:path";
import type {
  Hardware,
  LlamaBackend,
  LocalModel,
  LocalModelStatus,
  LocalModelsState,
  ModelDetails,
  Progress,
  ServerStatus,
  SuggestedModel,
} from "@apollo/contracts";
import { type LlamaCppConnection, ProviderError } from "@apollo/providers";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../Config.ts";
import { parseVerdict, type ReviewedCall, reviewMessages } from "./Reviewer.ts";
import { ProviderSettings } from "../ProviderSettings.ts";
import { Store } from "../Store.ts";
import {
  type ConcreteBackend,
  type InstalledEngine,
  installEngine,
  latestRelease,
  readInstalled,
  recommendBackend,
  serverBinary,
} from "./Engine.ts";
import { detectHardware } from "./Hardware.ts";
import { modelDetails, searchModels, suggestModels, TARGET_CONTEXT } from "./Lookup.ts";

const DEFAULT_MODEL_KEY = "llamacpp.defaultModel";
const REVIEWER_MODEL_KEY = "llamacpp.reviewerModel";
/** Downloads started but not finished, resumed when llama-server starts again. */
const PENDING_DOWNLOADS_KEY = "llamacpp.pendingDownloads";
/** Unload a model's weights after this long without requests; the next one reloads it. */
const IDLE_SLEEP_SECONDS = 15 * 60;
const MAX_LOG_LINES = 400;
const MAX_RESTARTS = 3;

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

/** The router's view of one model (`GET /models`). */
interface RouterModel {
  id: string;
  status?: { value?: string; failed?: boolean };
  context_length?: number;
  memory?: {
    max?: { n_ctx?: number; devices?: Array<{ kind: string; model: number }> } | null;
    effective?: { n_ctx?: number; devices?: Array<{ kind: string; model: number }> } | null;
  };
}

const MODEL_STATUSES = new Set<LocalModelStatus>(["unloaded", "loading", "loaded", "sleeping", "downloading", "incomplete", "failed"]);

/** llama.cpp lists a model whose download stopped part way as `incomplete`. */
const isIncomplete = (m: RouterModel) => m.status?.value === "incomplete";

/**
 * Stops llama-server processes left running by an earlier Apollo that ended without
 * shutting them down (a crash, a force quit): any process started from Apollo's own
 * engines folder that is not a child of this process. They would hold memory and ports.
 */
export const reapOrphans = (enginesDir: string) => {
  if (process.platform === "win32") return 0;
  let listing = "";
  try {
    listing = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  } catch {
    return 0;
  }
  let stopped = 0;
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, command] = match;
    if (!command!.startsWith(`${enginesDir}/`) || Number(ppid) === process.pid || Number(pid) === process.pid) continue;
    try {
      process.kill(Number(pid), "SIGTERM");
      stopped++;
    } catch {
      // Already gone.
    }
  }
  return stopped;
};

/**
 * Overall load progress (0-1) from a llama-server `status_change` event. Loading goes
 * through stages (the text model, then e.g. a vision projector); the text model is
 * nearly all of the bytes, so it counts for 90%.
 */
export const loadProgressOf = (progress: unknown): number | null => {
  const p = progress as { stages?: Array<string>; current?: string; value?: number } | undefined;
  if (!p?.stages?.length || !p.current || typeof p.value !== "number") return null;
  const weights = p.stages.map((stage) =>
    p.stages!.includes("text_model") ? (stage === "text_model" ? 0.9 : 0.1 / (p.stages!.length - 1 || 1)) : 1 / p.stages!.length,
  );
  const index = p.stages.indexOf(p.current);
  if (index < 0) return null;
  const done = weights.slice(0, index).reduce((sum, w) => sum + w, 0);
  return Math.min(1, Math.max(0, done + weights[index]! * Math.min(1, Math.max(0, p.value))));
};

export const toLocalModel = (m: RouterModel, download: Progress | undefined, loadProgress: number | null = null): LocalModel => {
  const measured = m.memory?.effective ?? m.memory?.max ?? null;
  const devices = measured?.devices ?? [];
  const sizeBytes = devices.length > 0 ? devices.reduce((sum, d) => sum + d.model, 0) : null;
  // Weights left on the host mean part of the model runs from system RAM.
  const onHost = devices.filter((d) => d.kind === "host").reduce((sum, d) => sum + d.model, 0);
  const value = m.status?.value as LocalModelStatus | undefined;
  return {
    id: m.id,
    status: download ? "downloading" : m.status?.failed ? "failed" : value && MODEL_STATUSES.has(value) ? value : "unloaded",
    sizeBytes,
    download: download ?? null,
    loadProgress: !download && value === "loading" ? loadProgress : null,
    contextSize: measured?.n_ctx ?? null,
    fit: devices.length === 0 ? null : onHost > 256 * 1024 * 1024 ? "ram" : "gpu",
  };
};

/**
 * The router's command line. Model processes inherit these flags. Without a cap, `--fit`
 * sizes each model's context from its own (shrinking it to fit memory, never below what
 * the agent needs). A cap sets `--ctx-size`, which `--fit` then leaves alone: no model
 * allocates a KV cache beyond it (a model that would not fit moves layers to RAM instead).
 */
export const serverArgs = (options: { port: number; apiKey: string; maxContextTokens: number | null }) => {
  const { port, apiKey, maxContextTokens: cap } = options;
  return [
    "--host", "127.0.0.1",
    "--port", String(port),
    "--api-key", apiKey,
    "--no-webui",
    "--sleep-idle-seconds", String(IDLE_SLEEP_SECONDS),
    // Let --fit size each model, but never below what the agent needs (nor above the cap).
    "--fit-ctx", String(cap === null ? TARGET_CONTEXT : Math.min(TARGET_CONTEXT, cap)),
    ...(cap === null ? [] : ["--ctx-size", String(cap)]),
    // An 8-bit KV cache halves its memory for a negligible quality cost.
    "--cache-type-k", "q8_0",
    "--cache-type-v", "q8_0",
    // Unload idle models when a new one needs the memory.
    "--models-memory-margin", "1024",
  ];
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const store = yield* Store;
  const providerSettings = yield* ProviderSettings;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);

  const root = join(config.dataDir, "llamacpp");
  const cacheDir = join(root, "models");
  mkdirSync(cacheDir, { recursive: true });

  let engine: InstalledEngine | null = readInstalled(root);
  // Detecting GPUs runs vendor tools and initializes CUDA: seconds. Do it in the
  // background so the app starts at once; what needs the answer waits for it.
  let hardware: Hardware = { platform: platform(), arch: arch(), ramBytes: totalmem(), gpus: [], cudaVersion: null };
  const detected = yield* Deferred.make<void>();
  const hardwareKnown = Deferred.await(detected);
  let latestTag: string | null = null;
  let installing: LocalModelsState["engine"]["installing"] = null;
  let engineError: string | null = null;
  let serverStatus: ServerStatus = "stopped";
  let serverError: string | null = null;
  let routerModels: Array<RouterModel> = [];
  const downloads = new Map<string, Progress>();
  /** Models being loaded into memory, with progress 0-1. */
  const loading = new Map<string, number>();
  /** Orphans from a previous run are stopped once, before the first start. */
  let reaped = false;
  let defaultModel = yield* store.getSetting(DEFAULT_MODEL_KEY);
  let reviewerModel = yield* store.getSetting(REVIEWER_MODEL_KEY);
  const pendingDownloads = new Set<string>();
  try {
    const saved: unknown = JSON.parse((yield* store.getSetting(PENDING_DOWNLOADS_KEY)) ?? "[]");
    if (Array.isArray(saved)) for (const id of saved) if (typeof id === "string") pendingDownloads.add(id);
  } catch {}
  const savePending = () =>
    runFork(store.setSetting(PENDING_DOWNLOADS_KEY, pendingDownloads.size ? JSON.stringify([...pendingDownloads]) : null));
  const forgetPending = (model: string) => {
    if (pendingDownloads.delete(model)) savePending();
  };

  const changes = yield* PubSub.sliding<LocalModelsState>(64);

  const state = (): LocalModelsState => {
    const listed = routerModels.map((m) => toLocalModel(m, downloads.get(m.id), loading.get(m.id) ?? null));
    const pending = [...downloads.entries()]
      .filter(([id]) => !routerModels.some((m) => m.id === id))
      .map(([id, download]): LocalModel => ({
        id,
        status: "downloading",
        sizeBytes: null,
        download,
        loadProgress: null,
        contextSize: null,
        fit: null,
      }));
    return {
      hardware,
      engine: {
        installed: engine ? { tag: engine.tag, backend: engine.backend, installedAt: engine.installedAt } : null,
        latestTag,
        recommendedBackend: recommendBackend(hardware),
        installing,
        error: engineError,
      },
      server: { status: serverStatus, error: serverError },
      models: [...listed, ...pending],
      defaultModel,
      reviewerModel,
    };
  };

  // Progress events arrive many times a second; the UI needs a few.
  let lastPublished = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const notify = (urgent = true) => {
    const publish = () => {
      lastPublished = Date.now();
      trailing = null;
      runFork(PubSub.publish(changes, state()));
    };
    if (urgent || Date.now() - lastPublished > 300) return publish();
    trailing ??= setTimeout(publish, 300);
  };

  // -------------------------------------------------------------------------
  // llama-server (router mode)
  // -------------------------------------------------------------------------

  const apiKey = randomBytes(24).toString("hex");
  let port: number | null = null;
  let child: ChildProcess | null = null;
  let wanted = false;
  let restarts = 0;
  let ready: Promise<void> | null = null;
  let events: AbortController | null = null;
  const logs: Array<string> = [];

  const baseUrl = () => `http://127.0.0.1:${port}`;
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...init.headers },
    });
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!response.ok) throw new Error(body?.error?.message ?? `llama-server answered ${response.status}`);
    return body;
  };

  const log = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      logs.push(line);
      if (logs.length > MAX_LOG_LINES) logs.shift();
    }
  };

  const refreshModels = async () => {
    const body = (await api("/models")) as { data?: Array<RouterModel> } | null;
    routerModels = body?.data ?? [];
    if (defaultModel && !routerModels.some((m) => m.id === defaultModel)) defaultModel = null;
    notify();
  };

  /** Follows `/models/sse` for download progress and load/sleep status. */
  const followEvents = async (signal: AbortSignal) => {
    const response = await fetch(`${baseUrl()}/models/sse`, { signal, headers: { authorization: `Bearer ${apiKey}` } });
    if (!response.ok || !response.body) throw new Error(`event stream answered ${response.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;
        const event = JSON.parse(data) as { model: string; event: string; data?: Record<string, unknown> };
        handleEvent(event);
      }
    }
  };

  const handleEvent = (event: { model: string; event: string; data?: Record<string, unknown> }) => {
    switch (event.event) {
      case "download_progress": {
        const files = Object.values((event.data?.progress ?? {}) as Record<string, { done: number; total: number }>);
        downloads.set(event.model, {
          done: files.reduce((sum, f) => sum + f.done, 0),
          total: files.reduce((sum, f) => sum + f.total, 0),
        });
        return notify(false);
      }
      case "download_finished":
      case "download_failed": {
        downloads.delete(event.model);
        // A download cut short by Apollo stopping the server resumes next time.
        if (event.event === "download_finished" || wanted) forgetPending(event.model);
        if (event.event === "download_failed") logs.push(`Download of ${event.model} failed: ${JSON.stringify(event.data ?? {})}`);
        void refreshModels().catch(() => notify());
        return;
      }
      case "status_change": {
        const status = event.data?.status;
        const model = routerModels.find((m) => m.id === event.model);
        if (status === "loading") {
          const progress = loadProgressOf(event.data?.progress);
          if (progress !== null) loading.set(event.model, progress);
          else if (!loading.has(event.model)) loading.set(event.model, 0);
          if (model) model.status = { value: "loading" };
          return notify(false);
        }
        loading.delete(event.model);
        if (model && typeof status === "string") model.status = { value: status };
        if (status === "loaded" || status === "unloaded") void refreshModels().catch(() => notify());
        return notify();
      }
      case "model_status": {
        const model = routerModels.find((m) => m.id === event.model);
        const status = event.data?.status;
        if (model && typeof status === "string") model.status = { value: status };
        if (status !== "loading") loading.delete(event.model);
        // A finished load carries the measured memory; read it.
        if (status === "loaded" || status === "unloaded") void refreshModels().catch(() => notify());
        return notify();
      }
      default:
        void refreshModels().catch(() => notify());
    }
  };

  const waitForHealth = async (process: ChildProcess) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (process.exitCode !== null) throw new Error(`llama-server exited (${process.exitCode}): ${logs.slice(-3).join(" ")}`);
      try {
        const response = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("llama-server did not become ready within a minute");
  };

  const launch = async () => {
    if (!engine) throw new Error("llama.cpp is not installed");
    port ??= await freePort();
    const { maxContextTokens } = (await runPromise(providerSettings.read)).llamacpp;
    const args = serverArgs({ port, apiKey, maxContextTokens });
    logs.push(`$ llama-server ${args.map((a) => (a === apiKey ? "<key>" : a)).join(" ")}`);
    const process_ = spawn(serverBinary(engine), args, {
      env: { ...process.env, LLAMA_CACHE: cacheDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child = process_;
    process_.stdout?.on("data", log);
    process_.stderr?.on("data", log);
    process_.on("exit", (code, signal) => {
      if (child !== process_) return;
      child = null;
      events?.abort();
      ready = null;
      if (!wanted) {
        serverStatus = "stopped";
        return notify();
      }
      logs.push(`llama-server exited (${signal ?? code})`);
      if (restarts < MAX_RESTARTS) {
        restarts++;
        serverStatus = "starting";
        notify();
        setTimeout(() => wanted && void startServer().catch(() => undefined), 1000 * restarts);
      } else {
        serverStatus = "error";
        serverError = `llama-server keeps exiting (${signal ?? code}). See its log.`;
        notify();
      }
    });
    await waitForHealth(process_);
    events = new AbortController();
    const signal = events.signal;
    void followEvents(signal).catch(() => undefined);
    await refreshModels();
    resumeDownloads();
  };

  /**
   * Starts again the downloads that were running when Apollo (or llama-server)
   * stopped. llama.cpp keeps the partial file and continues from it.
   */
  const resumeDownloads = () => {
    // llama.cpp's own record catches downloads Apollo did not save (e.g. older versions).
    const before = pendingDownloads.size;
    for (const m of routerModels) if (isIncomplete(m)) pendingDownloads.add(m.id);
    if (pendingDownloads.size !== before) savePending();
    for (const model of [...pendingDownloads]) {
      const listed = routerModels.find((m) => m.id === model);
      if (listed && !isIncomplete(listed) && !downloads.has(model)) {
        forgetPending(model);
        continue;
      }
      if (!downloads.has(model)) downloads.set(model, { done: 0, total: 0 });
      logs.push(`Resuming the download of ${model}`);
      void api("/models", { method: "POST", body: JSON.stringify({ model }) }).catch((error) => {
        logs.push(`Could not resume ${model}: ${errorText(error)}`);
        downloads.delete(model);
        notify();
      });
    }
    notify();
  };

  const startServer = (): Promise<void> => {
    if (ready) return ready;
    if (!reaped) {
      reaped = true;
      reapOrphans(join(root, "engines"));
    }
    wanted = true;
    serverStatus = "starting";
    serverError = null;
    notify();
    ready = launch().then(
      () => {
        serverStatus = "running";
        notify();
      },
      (error) => {
        ready = null;
        serverStatus = "error";
        serverError = errorText(error);
        child?.kill();
        notify();
        throw error;
      },
    );
    return ready;
  };

  const stopServer = async () => {
    wanted = false;
    restarts = 0;
    events?.abort();
    const process_ = child;
    if (!process_) {
      serverStatus = "stopped";
      return notify();
    }
    const exited = new Promise<void>((resolve) => process_.once("exit", () => resolve()));
    process_.kill("SIGTERM");
    const timer = setTimeout(() => process_.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  };

  yield* Effect.addFinalizer(() => Effect.promise(stopServer));

  const fail = (message: string) => new Error(message);
  const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => fail(errorText(e)) });

  // -------------------------------------------------------------------------
  // Engine
  // -------------------------------------------------------------------------

  const resolveBackend = (backend: LlamaBackend): ConcreteBackend =>
    backend === "auto" ? recommendBackend(hardware) : backend;

  const install = (requested: LlamaBackend) =>
    Effect.gen(function* () {
      if (installing) return yield* Effect.fail(fail("llama.cpp is already being installed"));
      yield* hardwareKnown;
      const backend = resolveBackend(requested);
      installing = { backend, step: "Finding the latest build", progress: { done: 0, total: 0 } };
      engineError = null;
      notify();
      const work = Effect.gen(function* () {
        const { release, assets } = yield* latestRelease(hardware, backend);
        const wasRunning = wanted;
        yield* Effect.promise(stopServer);
        const installed = yield* installEngine(root, release, assets, backend, (step, done, total) => {
          installing = { backend, step, progress: { done, total } };
          notify(false);
        });
        engine = installed;
        latestTag = release.tag;
        hardware = yield* detectHardware(serverBinary(installed));
        installing = null;
        notify();
        if (wasRunning || (yield* providerSettings.read).llamacpp.mode === "managed") {
          yield* Effect.promise(() => startServer().catch(() => undefined));
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            installing = null;
            engineError = errorText(error);
            notify();
          }),
        ),
      );
      // Runs in the background; progress arrives as state changes.
      runFork(work);
    });

  const checkForUpdate = Effect.gen(function* () {
    yield* hardwareKnown;
    const backend = engine?.backend ?? recommendBackend(hardware);
    const result = yield* latestRelease(hardware, backend).pipe(Effect.option);
    if (result._tag === "Some") latestTag = result.value.release.tag;
    notify();
    return state();
  });

  runFork(
    Effect.gen(function* () {
      hardware = yield* detectHardware(engine ? serverBinary(engine) : null);
      yield* Deferred.succeed(detected, undefined);
      notify();
    }),
  );
  // Start with Apollo, like the rest of the app.
  if (engine && (yield* providerSettings.read).llamacpp.mode === "managed") {
    runFork(Effect.promise(() => startServer().catch(() => undefined)));
  }
  runFork(checkForUpdate.pipe(Effect.delay(Duration.seconds(5))));

  // -------------------------------------------------------------------------
  // Lookup (cached: Hugging Face answers change slowly)
  // -------------------------------------------------------------------------

  const suggested = yield* Effect.cachedInvalidateWithTTL(
    Effect.flatMap(hardwareKnown, () => suggestModels(hardware)),
    Duration.hours(6),
  );
  const detailsCache = new Map<string, { at: number; details: ModelDetails }>();

  const requireRunning = (action: string) =>
    Effect.gen(function* () {
      if (!engine) return yield* Effect.fail(fail(`Install llama.cpp before you ${action}.`));
      yield* attempt(startServer);
    });

  return {
    /** Waits for hardware detection, so the first answer is complete. */
    state: Effect.map(hardwareKnown, state),
    changes: Stream.fromPubSub(changes),
    logs: Effect.sync(() => [...logs]),

    installEngine: install,
    checkForUpdate,
    startServer: Effect.gen(function* () {
      restarts = 0;
      yield* requireRunning("start the server");
    }),
    stopServer: Effect.promise(stopServer),
    /** Starts llama-server again with the current settings, if it is running (or starting). */
    restartServer: Effect.promise(async () => {
      if (!wanted) return;
      logs.push("Restarting llama-server to apply new settings");
      await stopServer();
      restarts = 0;
      await startServer().catch(() => undefined);
    }),

    suggested: suggested[0] as Effect.Effect<ReadonlyArray<SuggestedModel>, Error>,
    search: (query: string) => searchModels(query),
    details: (repo: string) =>
      Effect.gen(function* () {
        const hit = detailsCache.get(repo);
        if (hit && Date.now() - hit.at < 3600_000) return hit.details;
        yield* hardwareKnown;
        const details = yield* modelDetails(repo, hardware);
        detailsCache.set(repo, { at: Date.now(), details });
        return details;
      }),

    download: (repo: string, quant: string) =>
      Effect.gen(function* () {
        yield* requireRunning("download models");
        const model = `${repo}:${quant}`;
        downloads.set(model, { done: 0, total: 0 });
        pendingDownloads.add(model);
        savePending();
        notify();
        yield* attempt(() => api("/models", { method: "POST", body: JSON.stringify({ model }) })).pipe(
          Effect.tapError(() => Effect.sync(() => (downloads.delete(model), forgetPending(model), notify()))),
        );
      }),
    cancelDownload: (model: string) =>
      Effect.gen(function* () {
        forgetPending(model);
        yield* attempt(() => api(`/models?model=${encodeURIComponent(model)}`, { method: "DELETE" }));
        downloads.delete(model);
        yield* attempt(refreshModels);
      }),
    deleteModel: (model: string) =>
      Effect.gen(function* () {
        yield* requireRunning("delete models");
        yield* attempt(() => api(`/models?model=${encodeURIComponent(model)}`, { method: "DELETE" }));
        if (defaultModel === model) {
          defaultModel = null;
          yield* store.setSetting(DEFAULT_MODEL_KEY, null);
        }
        if (reviewerModel === model) {
          reviewerModel = null;
          yield* store.setSetting(REVIEWER_MODEL_KEY, null);
        }
        yield* attempt(refreshModels);
      }),
    setDefault: (model: string | null) =>
      Effect.gen(function* () {
        defaultModel = model;
        yield* store.setSetting(DEFAULT_MODEL_KEY, model);
        notify();
      }),
    setReviewer: (model: string | null) =>
      Effect.gen(function* () {
        reviewerModel = model;
        yield* store.setSetting(REVIEWER_MODEL_KEY, model);
        notify();
      }),
    /**
     * Asks the reviewer model whether an unclear tool call may run in auto mode. `ask`
     * whenever there is no reviewer, it is still downloading, or it does not answer in time.
     */
    review: (call: ReviewedCall) =>
      Effect.gen(function* () {
        const model = reviewerModel;
        if (!model || !engine || downloads.has(model) || !routerModels.some((m) => m.id === model)) return "ask" as const;
        yield* Effect.tryPromise(startServer).pipe(Effect.orElseSucceed(() => undefined));
        const body = (yield* attempt(() =>
          api("/v1/chat/completions", {
            method: "POST",
            // The first review may load the model into memory.
            signal: AbortSignal.timeout(45_000),
            body: JSON.stringify({
              model,
              messages: reviewMessages(call),
              temperature: 0,
              max_tokens: 8,
              chat_template_kwargs: { enable_thinking: false },
            }),
          }),
        ).pipe(Effect.orElseSucceed(() => null))) as { choices?: Array<{ message?: { content?: string } }> } | null;
        const verdict = parseVerdict(body?.choices?.[0]?.message?.content ?? "");
        logs.push(`Reviewer ${verdict === "allow" ? "allowed" : "asked about"} ${call.tool}`);
        return verdict;
      }),

    /**
     * The managed server, started if needed, for the llama.cpp provider. Fails with
     * what to do when nothing is set up yet.
     */
    /**
     * The download a session on `model` (or on the default, when `null`) has to
     * wait for, if any.
     */
    downloadBlocking: (model: string | null) =>
      Effect.sync(() => {
        const unfinished = (id: string) => downloads.has(id) || routerModels.some((m) => m.id === id && isIncomplete(m));
        if (model) return unfinished(model) ? model : null;
        const ready = routerModels.some((m) => !unfinished(m.id) && !m.status?.failed);
        if (!ready) {
          const partial = routerModels.find(isIncomplete);
          if (partial && downloads.size === 0) return partial.id;
        }
        return ready ? null : ([...downloads.keys()][0] ?? null);
      }),
    connection: Effect.gen(function* () {
      const notReady = (message: string) => new ProviderError({ provider: "llamacpp", message });
      if (!engine) return yield* Effect.fail(notReady("llama.cpp is not installed yet. Set it up in Providers → Local models."));
      yield* Effect.tryPromise({ try: startServer, catch: (e) => notReady(`llama-server failed to start: ${errorText(e)}`) });
      const usable = routerModels.filter((m) => !downloads.has(m.id) && !m.status?.failed && !isIncomplete(m));
      if (usable.length === 0) {
        return yield* Effect.fail(notReady("No local model is downloaded yet. Pick one in Providers → Local models."));
      }
      return { baseUrl: baseUrl(), apiKey, defaultModel: defaultModel ?? usable[0]!.id } satisfies LlamaCppConnection;
    }),
  };
});

export class LocalModels extends Context.Service<LocalModels, Effect.Success<typeof make>>()("apollo/LocalModels") {}

export const layer = Layer.effect(LocalModels, make);
