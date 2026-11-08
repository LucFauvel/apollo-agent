import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentEvent, ApprovalDecision, ModelOption, Usage } from "@apollo/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { findExecutable, fullInstructions } from "./AgentSupport.ts";
import { makeInputRequests } from "./InputRequests.ts";
import { PI_EXTENSION_SOURCE } from "./PiExtension.ts";
import {
  type Attachment,
  attachmentNote,
  type Emit,
  isImageAttachment,
  type Provider,
  type ProviderCommand,
  ProviderError,
  type ProviderSessionOptions,
  summarizeToolInput,
  truncate,
} from "./Provider.ts";

/**
 * Pi (`@earendil-works/pi-coding-agent`) in RPC mode: `pi --mode rpc` reads commands as
 * JSON lines (`{type, id}`) and writes responses (`{type: "response", id, success, data}`)
 * and events (`agent_start`, `message_update`, `tool_execution_*` ...). Apollo's MCP tools,
 * approvals and instructions come through an extension (see PiExtension.ts).
 */

const fail = (message: string) => new ProviderError({ provider: "pi", message });
const HINT = "Install Pi (npm install -g @earendil-works/pi-coding-agent) and sign in to a model provider with `pi`.";
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface PiProviderConfig {
  readonly executable?: string | undefined;
  /** Where Apollo writes the extension and per-session instruction files. */
  readonly stateDir: string;
}

type PiMessage = Record<string, unknown>;

interface PiProcess {
  readonly request: (command: Record<string, unknown>) => Effect.Effect<unknown, ProviderError>;
  readonly send: (message: Record<string, unknown>) => void;
}

const record = (v: unknown): PiMessage => (v && typeof v === "object" && !Array.isArray(v) ? (v as PiMessage) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Starts `pi --mode rpc` for as long as the scope is open. */
const spawnPi = (
  config: PiProviderConfig,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string>,
  onEvent: (event: PiMessage) => Effect.Effect<void>,
  onExit: (reason: string) => Effect.Effect<void>,
): Effect.Effect<PiProcess, ProviderError, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const run = Effect.runForkWith(context);
    const command = findExecutable(config.executable ? [config.executable, "pi"] : ["pi"]);
    if (!command) return yield* fail(`Pi (\`pi\`) was not found. ${HINT}`);
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () => spawn(command, ["--mode", "rpc", ...args], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }),
        catch: (cause) => fail(`failed to start pi: ${String(cause)}`),
      }),
      (child) => Effect.sync(() => void (child.exitCode === null && child.signalCode === null && child.kill("SIGTERM"))),
    );
    const pending = new Map<string, Deferred.Deferred<unknown, ProviderError>>();
    let next = 1;
    let exited = false;
    let stderr = "";
    const send = (message: Record<string, unknown>) => {
      if (!exited) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let message: PiMessage;
      try {
        message = record(JSON.parse(line));
      } catch {
        return;
      }
      if (message.type === "response" && typeof message.id === "string" && pending.has(message.id)) {
        const deferred = pending.get(message.id)!;
        pending.delete(message.id);
        run(
          message.success === false
            ? Deferred.fail(deferred, fail(`${String(message.command ?? "pi")}: ${String(message.error ?? "failed")}`))
            : Deferred.succeed(deferred, message.data),
        );
        return;
      }
      run(onEvent(message));
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      stderr = `${stderr}\n${line}`.slice(-2000);
    });
    const exit = (reason: string) => {
      if (exited) return;
      exited = true;
      for (const deferred of pending.values()) run(Deferred.fail(deferred, fail(reason)));
      pending.clear();
      run(onExit(reason));
    };
    child.on("error", (error) => exit(`pi failed: ${error.message}`));
    child.on("exit", (code, signal) => exit(`pi exited (${signal ?? `code ${code}`})${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`));
    return {
      send,
      request: (command) =>
        Effect.gen(function* () {
          if (exited) return yield* fail("pi is not running");
          const id = `apollo-${next++}`;
          const deferred = yield* Deferred.make<unknown, ProviderError>();
          pending.set(id, deferred);
          send({ ...command, id });
          return yield* Deferred.await(deferred);
        }),
    };
  });

interface PiModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string | undefined;
  readonly reasoning: boolean;
  readonly contextWindow: number | undefined;
}

const modelsOf = (data: unknown): Array<PiModel> =>
  ((record(data).models ?? []) as Array<unknown>).map(record).flatMap((m) =>
    typeof m.provider === "string" && typeof m.id === "string"
      ? [{ provider: m.provider, id: m.id, name: str(m.name), reasoning: m.reasoning === true, contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined }]
      : [],
  );

const listPiModels = (config: PiProviderConfig) =>
  Effect.gen(function* () {
    const pi = yield* spawnPi(config, ["--no-session"], tmpdir(), {}, () => Effect.void, () => Effect.void);
    const current = record(record(yield* pi.request({ type: "get_state" })).model);
    const models = modelsOf(yield* pi.request({ type: "get_available_models" }));
    if (models.length === 0) return yield* fail(`Pi has no models it can use yet. ${HINT}`);
    return models.map(
      (m): ModelOption => ({
        id: `${m.provider}/${m.id}`,
        label: m.name ?? m.id,
        description: m.provider,
        isDefault: m.provider === current.provider && m.id === current.id,
        efforts: m.reasoning ? THINKING : [],
        defaultEffort: null,
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.mapError((e) => (e instanceof ProviderError ? e : fail("Pi took too long to list its models"))),
  );

/** A Pi tool's name as Apollo groups them. */
const toolName = (name: string) => {
  switch (name) {
    case "bash":
      return "shell";
    case "edit":
    case "write":
      return "edit";
    case "grep":
    case "find":
      return "search";
    default:
      return name;
  }
};

const resultText = (result: unknown) => {
  const r = record(result);
  const parts = Array.isArray(r.content) ? r.content.map(record).flatMap((p) => (p.type === "text" && typeof p.text === "string" ? [p.text] : [])) : [];
  return truncate(parts.length > 0 ? parts.join("\n") : typeof result === "string" ? result : JSON.stringify(result ?? ""), 4000);
};

export const makePiProvider = (config: PiProviderConfig): Provider => ({
  kind: "pi",
  listModels: listPiModels(config),
  open: Effect.fn("PiProvider.open")(function* (options: ProviderSessionOptions, emit: Emit) {
    const scope = yield* Effect.scope;
    const event = (e: AgentEvent) => emit({ _tag: "Event", event: e });
    const readOnly = options.readOnly === true;

    // The extension, and this session's instructions (re-read before each turn).
    const dir = join(config.stateDir, "pi");
    mkdirSync(dir, { recursive: true });
    const extension = join(dir, "apollo-extension.ts");
    let current = "";
    try {
      current = readFileSync(extension, "utf8");
    } catch {
      // first run
    }
    if (current !== PI_EXTENSION_SOURCE) writeFileSync(extension, PI_EXTENSION_SOURCE);
    const instructions = join(dir, `instructions-${randomBytes(6).toString("hex")}.md`);
    writeFileSync(instructions, fullInstructions(options));
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(instructions, { force: true })));

    // --- events -------------------------------------------------------------------
    let inTurn = false;
    let failure: string | null = null;
    let aborted = false;
    let ordinal = 0;
    // Message ids must stay unique when the conversation is reopened in a new process.
    const prefix = `pi-${randomBytes(4).toString("hex")}`;
    const streams = new Map<string, string>();
    const totals: { -readonly [K in keyof Usage]: Usage[K] } = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
    let contextWindow = 0;

    const finishTurn = (wasAborted: boolean) =>
      Effect.suspend(() => {
        if (!inTurn) return Effect.void;
        inTurn = false;
        const outcome = wasAborted || aborted ? "interrupted" : failure ? "failed" : "completed";
        const error = outcome === "failed" ? failure : null;
        failure = null;
        aborted = false;
        return event({ _tag: "TurnCompleted", outcome, error });
      });

    const pendingApprovals = new Map<string, Deferred.Deferred<ApprovalDecision>>();
    const inputs = makeInputRequests(event, fail);

    const onUiRequest = (request: PiMessage) =>
      Effect.gen(function* () {
        const id = str(request.id);
        if (!id) return;
        const method = str(request.method);
        const title = str(request.title) ?? "";
        const message = str(request.message) ?? "";
        if (method === "notify") {
          const level = str(request.notifyType) === "error" ? "error" : str(request.notifyType) === "warning" ? "warning" : "info";
          return yield* event({ _tag: "Notice", level, message: message || title });
        }
        if (method === "confirm") {
          if (readOnly) return pi.send({ type: "extension_ui_response", id, confirmed: false });
          const requestId = `pi-${id}`;
          const deferred = yield* Deferred.make<ApprovalDecision>();
          pendingApprovals.set(requestId, deferred);
          const tool = /^Allow (.+)\?$/.exec(title)?.[1];
          yield* event({ _tag: "ApprovalRequested", requestId, title: tool === "bash" ? "Run command?" : tool === "edit" || tool === "write" ? "Edit files?" : title || "Allow?", detail: message });
          const answer = yield* Deferred.await(deferred).pipe(Effect.ensuring(Effect.sync(() => pendingApprovals.delete(requestId))));
          yield* event({ _tag: "ApprovalResolved", requestId, decision: answer });
          return pi.send({ type: "extension_ui_response", id, confirmed: answer !== "decline" });
        }
        if (method === "select" || method === "input" || method === "editor") {
          if (readOnly) return pi.send({ type: "extension_ui_response", id, cancelled: true });
          const choices = Array.isArray(request.options) ? request.options.map((o) => (typeof o === "string" ? o : String(record(o).label ?? record(o).value ?? ""))) : [];
          const response = yield* inputs.ask(`pi-input-${id}`, {
            source: "Pi",
            message: title || message,
            url: null,
            fields: [
              {
                name: "value",
                kind: method === "select" ? "select" : "string",
                title: title || "Answer",
                description: method === "select" ? message : "",
                required: true,
                options: choices.map((c) => ({ value: c, label: c })),
                default: str(request.prefill) ?? null,
                secret: false,
              },
            ],
          });
          return pi.send(
            response.action === "accept" ? { type: "extension_ui_response", id, value: String(response.values.value ?? "") } : { type: "extension_ui_response", id, cancelled: true },
          );
        }
        // Other UI (status lines, widgets) has nothing to show here.
      });

    const onEvent = (e: PiMessage): Effect.Effect<void> => {
      switch (e.type) {
        case "agent_start":
          if (inTurn) return Effect.void;
          inTurn = true;
          return event({ _tag: "TurnStarted" });
        case "message_start":
          if (record(e.message).role === "assistant") ordinal++;
          return Effect.void;
        case "message_update": {
          const delta = record(e.assistantMessageEvent);
          const kind = str(delta.type);
          const index = typeof delta.contentIndex === "number" ? delta.contentIndex : 0;
          const thinking = kind?.startsWith("thinking");
          const itemId = `${prefix}-${ordinal}-${index}-${thinking ? "thought" : "text"}`;
          if (kind === "text_delta" || kind === "thinking_delta") {
            const text = str(delta.delta) ?? "";
            streams.set(itemId, (streams.get(itemId) ?? "") + text);
            return event(thinking ? { _tag: "ReasoningDelta", itemId, text } : { _tag: "AssistantDelta", itemId, text });
          }
          if (kind === "text_end" || kind === "thinking_end") {
            const text = str(delta.content) ?? str(delta.thinking) ?? streams.get(itemId) ?? "";
            streams.delete(itemId);
            if (!text.trim()) return Effect.void;
            return event(thinking ? { _tag: "Reasoning", itemId, text } : { _tag: "AssistantMessage", itemId, text });
          }
          return Effect.void;
        }
        case "message_end": {
          const message = record(e.message);
          if (message.role !== "assistant") return Effect.void;
          if (message.stopReason === "error") failure = str(message.errorMessage) ?? "Pi reported a model error";
          if (message.stopReason === "aborted") aborted = true;
          const usage = record(message.usage);
          if (Object.keys(usage).length === 0) return Effect.void;
          const input = Number(usage.input ?? 0);
          const cached = Number(usage.cacheRead ?? 0);
          const output = Number(usage.output ?? 0);
          totals.inputTokens += input;
          totals.cachedInputTokens += cached;
          totals.outputTokens += output;
          totals.costUsd += Number(record(usage.cost).total ?? 0);
          return Effect.andThen(
            emit({ _tag: "UsageTotals", totals: { ...totals } }),
            contextWindow > 0 ? emit({ _tag: "ContextUsage", used: input + cached + Number(usage.cacheWrite ?? 0) + output, window: contextWindow }) : Effect.void,
          );
        }
        case "tool_execution_start": {
          const id = str(e.toolCallId);
          if (!id) return Effect.void;
          const parent = str(e.parentToolCallId);
          return event({
            _tag: "ToolStarted",
            itemId: id,
            name: toolName(str(e.toolName) ?? "tool"),
            summary: summarizeToolInput(e.args ?? {}),
            ...(parent ? { parentItemId: parent } : {}),
          });
        }
        case "tool_execution_end": {
          const id = str(e.toolCallId);
          return id ? event({ _tag: "ToolCompleted", itemId: id, output: resultText(e.result), isError: e.isError === true }) : Effect.void;
        }
        case "compaction_start":
        case "auto_compaction_start":
          return event({ _tag: "Compacting", active: true });
        case "compaction_end":
        case "auto_compaction_end":
          return event({ _tag: "Compacting", active: false });
        case "extension_ui_request":
          return onUiRequest(e).pipe(Effect.forkIn(scope), Effect.asVoid);
        case "extension_error":
          return event({ _tag: "Notice", level: "warning", message: `Pi extension error: ${str(e.error) ?? str(e.message) ?? "unknown"}` });
        // Not agent_end: retries, compaction or steering can follow it.
        case "agent_settled":
          return finishTurn(e.aborted === true);
        default:
          return Effect.void;
      }
    };

    const env: Record<string, string> = {
      APOLLO_PI_MODE: readOnly ? "read-only" : options.runtimeMode,
      APOLLO_PI_INSTRUCTIONS: instructions,
      ...(options.mcp ? { APOLLO_MCP_URL: options.mcp.url, APOLLO_MCP_TOKEN: options.mcp.bearerToken } : {}),
    };
    const args = [...(options.resumeId ? ["--session", options.resumeId] : []), "--extension", extension];
    const pi = yield* spawnPi(config, args, options.cwd, env, onEvent, (reason) => emit({ _tag: "Exited", reason }));

    // Model and thinking level, then the session file Pi will reopen next time.
    if (options.model) {
      const slash = options.model.indexOf("/");
      const provider = slash > 0 ? options.model.slice(0, slash) : undefined;
      const modelId = slash > 0 ? options.model.slice(slash + 1) : options.model;
      yield* pi
        .request({ type: "set_model", ...(provider ? { provider } : {}), modelId })
        .pipe(Effect.catch((error) => event({ _tag: "Notice", level: "warning", message: `Pi: could not use ${options.model} (${error.message})` })));
    }
    if (options.effort) yield* pi.request({ type: "set_thinking_level", level: options.effort }).pipe(Effect.ignore);
    const state = record(yield* pi.request({ type: "get_state" }));
    const sessionFile = str(state.sessionFile);
    if (sessionFile) yield* emit({ _tag: "ResumeId", resumeId: sessionFile });
    const model = record(state.model);
    if (typeof model.contextWindow === "number") contextWindow = model.contextWindow;

    return {
      send: (text: string, attachments: ReadonlyArray<Attachment> = []) =>
        Effect.suspend(() => {
          const images = attachments.filter(isImageAttachment).flatMap((a) => {
            try {
              return [{ type: "image", data: readFileSync(a.path).toString("base64"), mimeType: a.mime }];
            } catch {
              return [];
            }
          });
          // Mid-turn messages steer the running turn (Pi ignores it when idle; always sending it
          // avoids racing a run that started but has not reported agent_start yet).
          return pi
            .request({
              type: "prompt",
              message: text + attachmentNote(attachments),
              ...(images.length > 0 ? { images } : {}),
              streamingBehavior: "steer",
            })
            .pipe(Effect.asVoid);
        }),
      interrupt: Effect.suspend(() => {
        if (!inTurn) return Effect.void;
        aborted = true;
        return pi.request({ type: "abort" }).pipe(Effect.asVoid);
      }),
      respondApproval: (requestId: string, decision: ApprovalDecision) =>
        Effect.suspend(() => {
          const deferred = pendingApprovals.get(requestId);
          return deferred ? Deferred.succeed(deferred, decision).pipe(Effect.asVoid) : Effect.fail(fail(`unknown approval request ${requestId}`));
        }),
      respondInput: inputs.respond,
      reloadSkills: Effect.sync(() => writeFileSync(instructions, fullInstructions(options))),
      compact: (customInstructions: string) =>
        pi.request({ type: "compact", ...(customInstructions ? { customInstructions } : {}) }).pipe(Effect.asVoid),
      commands: pi.request({ type: "get_commands" }).pipe(
        Effect.map((data) =>
          ((record(data).commands ?? []) as Array<unknown>).map(record).flatMap((c): Array<ProviderCommand> =>
            typeof c.name === "string" ? [{ name: c.name, description: str(c.description) ?? "", argumentHint: "" }] : [],
          ),
        ),
        Effect.orElseSucceed(() => []),
      ),
    };
  }),
});
