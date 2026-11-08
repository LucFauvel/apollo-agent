import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AgentEvent, ApprovalDecision, ModelOption, ProviderKind, RuntimeMode } from "@apollo/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import {
  approvalTitle,
  autoDecision,
  bearer,
  instructionsPreamble,
  mcpStdioCommand,
  type ToolKind,
} from "./AgentSupport.ts";
import { makeInputRequests } from "./InputRequests.ts";
import { JsonRpcFailure, type JsonRpcProcess, spawnJsonRpcProcess } from "./JsonRpcProcess.ts";
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
 * Agents that speak the Agent Client Protocol (https://agentclientprotocol.com) over
 * stdio: JSON-RPC with `initialize`, `session/new|load|resume`, `session/prompt`,
 * `session/update` notifications and `session/request_permission` requests. One adapter
 * serves Cursor, Grok, OpenCode and Antigravity; each brings an `AcpAgent` with its launch
 * command and quirks.
 */

export interface AcpLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Added to (or, with `undefined`, removed from) the server's environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface AcpAgent {
  readonly kind: ProviderKind;
  /** As people know it: "Grok". */
  readonly name: string;
  /** How to start the agent: for a conversation, or for a short probe (`probe`) that lists models. */
  readonly launch: (input: {
    readonly runtimeMode: RuntimeMode;
    readonly readOnly: boolean;
    readonly probe: boolean;
  }) => Effect.Effect<AcpLaunch, ProviderError>;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  /** The auth method to use, from those the agent offers (null: none). */
  readonly authMethod?: (methods: ReadonlyArray<AcpAuthMethod>) => string | null;
  /** Authenticate before creating a session, not only after the agent asks for it. */
  readonly authenticateEagerly?: boolean;
  /** The session mode for a runtime mode, from the modes the agent offers (null: leave it). */
  readonly modeFor?: (mode: RuntimeMode, readOnly: boolean, available: ReadonlyArray<string>) => string | null;
  /** Reopen conversations with `session/resume` (no history replay) when offered, else `session/load`. */
  readonly preferResume?: boolean;
  /** `_meta` sent with `session/new`, `load` and `resume`. */
  readonly sessionMeta?: (options: ProviderSessionOptions) => Record<string, unknown> | undefined;
  /** Offer Apollo's MCP server over HTTP even when the agent does not advertise it. */
  readonly assumeHttpMcp?: boolean;
  /** A sign-in link in a line the agent printed (outside the protocol), if any. */
  readonly signInUrl?: (line: string) => string | null;
  /** Shown when the agent's CLI is missing or fails to start. */
  readonly installHint: string;
}

export interface AcpAuthMethod {
  readonly id: string;
  readonly name?: string;
  readonly description?: string | null;
}

// --- protocol views ----------------------------------------------------------

interface AcpInitializeResult {
  readonly protocolVersion?: number;
  readonly agentCapabilities?: {
    readonly loadSession?: boolean;
    readonly promptCapabilities?: { readonly image?: boolean };
    readonly mcpCapabilities?: { readonly http?: boolean; readonly sse?: boolean };
    readonly sessionCapabilities?: { readonly resume?: unknown };
  };
  readonly authMethods?: ReadonlyArray<AcpAuthMethod>;
}

interface AcpSelectOption {
  readonly value?: string;
  readonly name?: string;
  readonly description?: string | null;
  /** Grouped options carry their own list. */
  readonly options?: ReadonlyArray<AcpSelectOption>;
}

interface AcpConfigOption {
  readonly id: string;
  readonly name?: string;
  readonly category?: string | null;
  readonly type?: string;
  readonly currentValue?: unknown;
  readonly options?: ReadonlyArray<AcpSelectOption>;
}

interface AcpSessionResult {
  readonly sessionId?: string;
  readonly modes?: {
    readonly currentModeId?: string;
    readonly availableModes?: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
  } | null;
  readonly models?: {
    readonly currentModelId?: string;
    readonly availableModels?: ReadonlyArray<{ readonly modelId: string; readonly name?: string; readonly description?: string | null }>;
  } | null;
  readonly configOptions?: ReadonlyArray<AcpConfigOption> | null;
}

interface AcpToolCall {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly content?: ReadonlyArray<Record<string, unknown>> | null;
  readonly locations?: ReadonlyArray<{ readonly path?: string }> | null;
}

const AUTH_REQUIRED = -32000;

const flatOptions = (options: ReadonlyArray<AcpSelectOption> | undefined): Array<AcpSelectOption> =>
  (options ?? []).flatMap((o) => (o.options ? flatOptions(o.options) : o.value !== undefined ? [o] : []));

const modelOption = (config: ReadonlyArray<AcpConfigOption> | null | undefined) =>
  config?.find((o) => o.category === "model" || o.id === "model");
const effortOption = (config: ReadonlyArray<AcpConfigOption> | null | undefined) =>
  config?.find((o) => o.category === "thought_level" || o.id === "thought_level" || o.id === "reasoning_effort");

/** The models a session result offers, in Apollo's shape. */
export const acpModels = (result: AcpSessionResult): Array<ModelOption> => {
  const effort = effortOption(result.configOptions);
  const efforts = flatOptions(effort?.options).map((o) => o.value!);
  const defaultEffort = typeof effort?.currentValue === "string" ? effort.currentValue : null;
  const config = modelOption(result.configOptions);
  if (config) {
    return flatOptions(config.options).map((o) => ({
      id: o.value!,
      label: o.name || o.value!,
      description: o.description ?? "",
      isDefault: o.value === config.currentValue,
      efforts,
      defaultEffort,
    }));
  }
  return (result.models?.availableModels ?? []).map((m) => ({
    id: m.modelId,
    label: m.name || m.modelId,
    description: m.description ?? "",
    isDefault: m.modelId === result.models?.currentModelId,
    efforts,
    defaultEffort,
  }));
};

const TOOL_KINDS: ReadonlySet<string> = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
const toolKind = (kind: string | undefined): ToolKind => (kind && TOOL_KINDS.has(kind) ? (kind as ToolKind) : "other");

/** A tool call's name as Apollo's transcript groups them (shell, edit, read, search, web). */
const toolName = (call: AcpToolCall) => {
  switch (toolKind(call.kind)) {
    case "execute":
      return "shell";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "read":
      return "read";
    case "search":
      return "search";
    case "fetch":
      return "web fetch";
    case "think":
      return "think";
    default:
      return call.title?.trim() || "tool";
  }
};

const FILE_KINDS: ReadonlySet<ToolKind> = new Set(["edit", "delete", "move", "read"]);

const toolSummary = (call: AcpToolCall) => {
  // File steps read best as their path (their input is often a whole diff).
  const location = call.locations?.find((l) => l.path)?.path;
  if (location && FILE_KINDS.has(toolKind(call.kind))) return location;
  const input = call.rawInput !== undefined && call.rawInput !== null ? summarizeToolInput(call.rawInput) : "";
  if (input && input !== "{}") return input;
  const path = call.locations?.find((l) => l.path)?.path;
  if (path) return path;
  // A pending call's title is often a placeholder ("Preparing file…", "Terminal").
  return toolKind(call.kind) === "other" || call.status === "pending" || call.status === undefined ? "" : truncate(call.title ?? "", 200);
};

/** A tool call's result as text: its text content, the files a diff touched, or its raw output. */
const toolOutput = (call: AcpToolCall) => {
  // A command's own output beats the agent's description of it.
  if (toolKind(call.kind) === "execute" && call.rawOutput !== undefined && call.rawOutput !== null) {
    const raw = record(call.rawOutput);
    const text = typeof call.rawOutput === "string" ? call.rawOutput : [raw.stdout, raw.stderr, raw.output].filter((v) => typeof v === "string" && v).join("\n");
    if (text) return truncate(text, 4000);
  }
  const parts: Array<string> = [];
  for (const block of call.content ?? []) {
    if (block.type === "diff" && typeof block.path === "string") parts.push(`edited ${block.path}`);
    else if (block.type === "content") {
      const content = block.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && content.text) parts.push(content.text);
    } else if (block.type === "terminal") parts.push("(terminal output)");
  }
  if (parts.length === 0 && call.rawOutput !== undefined && call.rawOutput !== null) {
    parts.push(typeof call.rawOutput === "string" ? call.rawOutput : JSON.stringify(call.rawOutput));
  }
  return truncate(parts.join("\n"), 4000);
};

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const errorText = (error: { readonly message: string }) => error.message;

// --- the adapter ---------------------------------------------------------------

const spawnAgent = (
  agent: AcpAgent,
  launch: AcpLaunch,
  cwd: string,
  handlers: Parameters<typeof spawnJsonRpcProcess>[0]["handlers"],
) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(launch.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return spawnJsonRpcProcess({ command: launch.command, args: launch.args, cwd, env, handlers }).pipe(
    Effect.mapError((error) => new ProviderError({ provider: agent.kind, message: `${error.message}. ${agent.installHint}` })),
  );
};

const initialize = (agent: AcpAgent, rpc: JsonRpcProcess) =>
  rpc
    .request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: agent.clientInfo ?? { name: "apollo", title: "Apollo", version: "1.0.0" },
    })
    .pipe(
      Effect.map((result) => (result ?? {}) as AcpInitializeResult),
      Effect.mapError((error) => new ProviderError({ provider: agent.kind, message: `${agent.name} did not start: ${error.message}` })),
    );

/** Runs `effect`, and when the agent says it needs sign-in, authenticates and runs it again. */
const withAuth = <A>(
  agent: AcpAgent,
  rpc: JsonRpcProcess,
  init: AcpInitializeResult,
  effect: Effect.Effect<A, JsonRpcFailure>,
): Effect.Effect<A, ProviderError> => {
  const method = agent.authMethod?.(init.authMethods ?? []) ?? init.authMethods?.[0]?.id ?? null;
  const authenticate = method
    ? rpc.request("authenticate", { methodId: method }).pipe(
        Effect.asVoid,
        Effect.mapError(
          (error) =>
            new ProviderError({ provider: agent.kind, message: `${agent.name} needs you to sign in (${method}): ${error.message}. ${agent.installHint}` }),
        ),
      )
    : Effect.fail(new ProviderError({ provider: agent.kind, message: `${agent.name} needs you to sign in. ${agent.installHint}` }));
  const toProviderError = (error: JsonRpcFailure) => new ProviderError({ provider: agent.kind, message: error.message });
  return (agent.authenticateEagerly && method ? authenticate : Effect.void).pipe(
    Effect.andThen(
      effect.pipe(
        Effect.catch((error: JsonRpcFailure) =>
          error.code === AUTH_REQUIRED || /auth/i.test(error.message)
            ? Effect.andThen(authenticate, effect.pipe(Effect.mapError(toProviderError)))
            : Effect.fail(toProviderError(error)),
        ),
      ),
    ),
  );
};

const noHandlers = {
  onNotification: () => Effect.void,
  onRequest: (method: string) => Effect.fail(new JsonRpcFailure({ message: `Apollo does not handle ${method}` })),
  onExit: () => Effect.void,
};

/** Starts the agent in a scratch folder, opens a session and reads the models it offers. */
const listAcpModels = (agent: AcpAgent) =>
  Effect.gen(function* () {
    const launch = yield* agent.launch({ runtimeMode: "approval-required", readOnly: true, probe: true });
    const rpc = yield* spawnAgent(agent, launch, tmpdir(), noHandlers);
    const init = yield* initialize(agent, rpc);
    const result = (yield* withAuth(agent, rpc, init, rpc.request("session/new", { cwd: tmpdir(), mcpServers: [] }))) as AcpSessionResult;
    return acpModels(result ?? {});
  }).pipe(
    Effect.scoped,
    Effect.timeout("60 seconds"),
    Effect.mapError((e) => (e instanceof ProviderError ? e : new ProviderError({ provider: agent.kind, message: `${agent.name} took too long to list its models` }))),
  );

export const makeAcpProvider = (agent: AcpAgent): Provider => {
  const fail = (message: string) => new ProviderError({ provider: agent.kind, message });
  return {
    kind: agent.kind,
    listModels: listAcpModels(agent),
    open: Effect.fn("AcpProvider.open")(function* (options: ProviderSessionOptions, emit: Emit) {
      const scope = yield* Effect.scope;
      const event = (e: AgentEvent) => emit({ _tag: "Event", event: e });
      const readOnly = options.readOnly === true;

      let sessionId: string | null = null;
      /** While `session/load` replays history, its updates are not new activity. */
      let replaying = false;
      let commands: ReadonlyArray<ProviderCommand> = [];

      // Streamed text and thoughts collect here until something else happens. Their ids are
      // unique across reopenings, since the transcript keys messages by id.
      const prefix = `${agent.kind}-${randomBytes(4).toString("hex")}`;
      let counter = 0;
      let text: { id: string; value: string } | null = null;
      let thought: { id: string; value: string } | null = null;
      const flush = Effect.suspend(() => {
        const out: Array<AgentEvent> = [];
        if (thought) out.push({ _tag: "Reasoning", itemId: thought.id, text: thought.value });
        if (text) out.push({ _tag: "AssistantMessage", itemId: text.id, text: text.value });
        thought = null;
        text = null;
        return Effect.forEach(out, event, { discard: true });
      });

      /** Tool steps shown, with the summary they show. */
      const started = new Map<string, string>();
      const finished = new Set<string>();
      const toolStarted = (call: AcpToolCall) =>
        Effect.suspend(() => {
          const summary = toolSummary(call);
          const shown = started.get(call.toolCallId);
          if (shown !== undefined && (shown === summary || !summary)) return Effect.void;
          started.set(call.toolCallId, summary);
          // A second ToolStarted fills in the step's input once it arrives.
          return Effect.andThen(flush, event({ _tag: "ToolStarted", itemId: call.toolCallId, name: toolName(call), summary }));
        });
      const known = new Map<string, AcpToolCall>();
      const toolUpdate = (update: AcpToolCall) =>
        Effect.gen(function* () {
          const call = { ...known.get(update.toolCallId), ...update } as AcpToolCall;
          known.set(call.toolCallId, call);
          yield* toolStarted(call);
          if ((call.status === "completed" || call.status === "failed") && !finished.has(call.toolCallId)) {
            finished.add(call.toolCallId);
            yield* event({ _tag: "ToolCompleted", itemId: call.toolCallId, output: toolOutput(call), isError: call.status === "failed" });
          }
        });

      const onUpdate = (update: Record<string, unknown>): Effect.Effect<void> => {
        if (replaying) return Effect.void;
        const kind = update.sessionUpdate as string | undefined;
        const content = update.content as { type?: string; text?: string } | undefined;
        switch (kind) {
          case "agent_message_chunk": {
            if (content?.type !== "text" || !content.text) return Effect.void;
            const chunk = content.text;
            return Effect.suspend(() => {
              const before = thought ? flush : Effect.void;
              return Effect.andThen(before, () => {
                text ??= { id: `${prefix}-msg-${++counter}`, value: "" };
                text.value += chunk;
                return event({ _tag: "AssistantDelta", itemId: text.id, text: chunk });
              });
            });
          }
          case "agent_thought_chunk": {
            if (content?.type !== "text" || !content.text) return Effect.void;
            const chunk = content.text;
            return Effect.suspend(() => {
              const before = text ? flush : Effect.void;
              return Effect.andThen(before, () => {
                thought ??= { id: `${prefix}-thought-${++counter}`, value: "" };
                thought.value += chunk;
                return event({ _tag: "ReasoningDelta", itemId: thought.id, text: chunk });
              });
            });
          }
          case "tool_call":
          case "tool_call_update":
            return toolUpdate(update as unknown as AcpToolCall);
          case "usage_update": {
            const used = Number(update.used);
            const size = Number(update.size);
            return Number.isFinite(used) && Number.isFinite(size) && size > 0 ? emit({ _tag: "ContextUsage", used, window: size }) : Effect.void;
          }
          case "available_commands_update": {
            const list = (update.availableCommands ?? []) as ReadonlyArray<{ name: string; description?: string; input?: { hint?: string } | null }>;
            commands = list.map((c) => ({ name: c.name, description: c.description ?? "", argumentHint: c.input?.hint ?? "" }));
            return Effect.void;
          }
          case "compaction_update":
          case "compaction_started":
            return event({ _tag: "Compacting", active: update.status !== "completed" && update.status !== "failed" });
          case "compaction_completed":
            return event({ _tag: "Compacting", active: false });
          default:
            return Effect.void;
        }
      };

      // --- permission requests ---------------------------------------------------
      const pendingApprovals = new Map<string, Deferred.Deferred<ApprovalDecision>>();
      const inputs = makeInputRequests(event, fail);
      type PermissionOption = { optionId: string; name?: string; kind?: string };
      const pick = (options: ReadonlyArray<PermissionOption>, kinds: ReadonlyArray<string>) =>
        kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean)?.optionId ?? null;
      const selected = (optionId: string | null) =>
        optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };

      const onPermission = (params: Record<string, unknown>) =>
        Effect.gen(function* () {
          const call = { ...known.get(String((params.toolCall as AcpToolCall | undefined)?.toolCallId)), ...(params.toolCall as AcpToolCall) };
          const options = (params.options ?? []) as ReadonlyArray<PermissionOption>;
          const kind = toolKind(call.kind);
          const decision = autoDecision(options_.runtimeMode, readOnly, kind);
          if (decision === "allow") return selected(pick(options, options_.runtimeMode === "full-access" ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"]));
          if (decision === "reject") return selected(pick(options, ["reject_once", "reject_always"]));
          yield* toolStarted(call as AcpToolCall);
          const requestId = `${prefix}-perm-${++counter}`;
          const deferred = yield* Deferred.make<ApprovalDecision>();
          pendingApprovals.set(requestId, deferred);
          const detail = [call.title, toolSummary(call)].filter((v, i, all) => v && all.indexOf(v) === i).join("\n");
          yield* event({ _tag: "ApprovalRequested", requestId, title: approvalTitle(kind, call.title ?? ""), detail });
          const answer = yield* Deferred.await(deferred).pipe(Effect.ensuring(Effect.sync(() => pendingApprovals.delete(requestId))));
          yield* event({ _tag: "ApprovalResolved", requestId, decision: answer });
          return selected(
            answer === "accept"
              ? pick(options, ["allow_once", "allow_always"])
              : answer === "accept-for-session"
                ? pick(options, ["allow_always", "allow_once"])
                : pick(options, ["reject_once", "reject_always"]),
          );
        });
      const options_ = options;

      const onRequest = (method: string, params: unknown) => {
        const p = (params ?? {}) as Record<string, unknown>;
        if (method === "session/request_permission") return onPermission(p);
        return Effect.fail(new JsonRpcFailure({ message: `Apollo does not handle ${method}` }));
      };

      const onNotification = (method: string, params: unknown) => {
        const p = (params ?? {}) as Record<string, unknown>;
        if (method === "session/update" && (sessionId === null || p.sessionId === sessionId || p.sessionId === undefined)) {
          return onUpdate((p.update ?? {}) as Record<string, unknown>);
        }
        return Effect.void;
      };

      const signIn = (line: string) => {
        const url = agent.signInUrl?.(line);
        return url ? event({ _tag: "Notice", level: "warning", message: `${agent.name} needs you to sign in: ${url}` }) : Effect.void;
      };

      const launch = yield* agent.launch({ runtimeMode: options.runtimeMode, readOnly, probe: false });
      const rpc = yield* spawnAgent(agent, launch, options.cwd, {
        onNotification,
        onRequest,
        onExit: (reason) => emit({ _tag: "Exited", reason }),
        onStderr: signIn,
        onStdoutText: signIn,
      });
      const call = (method: string, params: unknown) => rpc.request(method, params).pipe(Effect.mapError((e) => fail(`${method}: ${e.message}`)));

      const init = yield* initialize(agent, rpc);
      const caps = init.agentCapabilities ?? {};

      // Apollo's MCP server: over HTTP when the agent takes it, else through a stdio bridge.
      const mcpServers = options.mcp
        ? caps.mcpCapabilities?.http || agent.assumeHttpMcp
          ? [{ type: "http", name: options.mcp.name, url: options.mcp.url, headers: [{ name: "Authorization", value: bearer(options.mcp) }] }]
          : (() => {
              const bridge = mcpStdioCommand(options.mcp);
              return [{ name: options.mcp.name, command: bridge.command, args: bridge.args, env: Object.entries(bridge.env).map(([name, value]) => ({ name, value })) }];
            })()
        : [];
      const meta = agent.sessionMeta?.(options);
      const sessionParams = { cwd: options.cwd, mcpServers, ...(meta ? { _meta: meta } : {}) };

      // Reopen the conversation when there is one; start fresh when the agent cannot.
      let result: AcpSessionResult | null = null;
      let fresh = true;
      if (options.resumeId) {
        const canResume = caps.sessionCapabilities?.resume !== undefined && caps.sessionCapabilities?.resume !== null;
        const method = canResume && (agent.preferResume || !caps.loadSession) ? "session/resume" : caps.loadSession ? "session/load" : null;
        if (method) {
          replaying = method === "session/load";
          const reopened = yield* withAuth(agent, rpc, init, rpc.request(method, { ...sessionParams, sessionId: options.resumeId })).pipe(
            Effect.map((r) => ({ ...((r ?? {}) as AcpSessionResult), sessionId: options.resumeId! })),
            Effect.catch((error) =>
              Effect.as(event({ _tag: "Notice", level: "warning", message: `${agent.name} could not reopen the conversation (${error.message}); starting a new one.` }), null),
            ),
          );
          replaying = false;
          if (reopened) {
            result = reopened;
            fresh = false;
          }
        }
      }
      if (!result) result = ((yield* withAuth(agent, rpc, init, rpc.request("session/new", sessionParams))) ?? {}) as AcpSessionResult;
      sessionId = result.sessionId ?? null;
      if (!sessionId) return yield* fail(`${agent.name} did not return a session id`);
      yield* emit({ _tag: "ResumeId", resumeId: sessionId });

      // Model, effort and mode.
      const warn = (what: string) => (error: ProviderError) => event({ _tag: "Notice", level: "warning", message: `${agent.name}: could not set ${what} (${errorText(error)})` });
      if (options.model) {
        const config = modelOption(result.configOptions);
        yield* (config
          ? call("session/set_config_option", { sessionId, configId: config.id, value: options.model })
          : call("session/set_model", { sessionId, modelId: options.model })
        ).pipe(Effect.catch(warn(`model ${options.model}`)));
      }
      if (options.effort) {
        const effort = effortOption(result.configOptions);
        if (effort) yield* call("session/set_config_option", { sessionId, configId: effort.id, value: options.effort }).pipe(Effect.catch(warn(`effort ${options.effort}`)));
      }
      // Modes come as session modes, or (newer agents) as a config option of category "mode".
      const modeConfig = result.configOptions?.find((o) => o.category === "mode");
      const modes = modeConfig ? flatOptions(modeConfig.options).map((o) => o.value!) : (result.modes?.availableModes ?? []).map((m) => m.id);
      const currentMode = modeConfig ? modeConfig.currentValue : result.modes?.currentModeId;
      const mode = agent.modeFor?.(options.runtimeMode, readOnly, modes) ?? null;
      if (mode && modes.includes(mode) && mode !== currentMode) {
        yield* (modeConfig
          ? call("session/set_config_option", { sessionId, configId: modeConfig.id, value: mode })
          : call("session/set_mode", { sessionId, modeId: mode })
        ).pipe(Effect.catch(warn(`mode ${mode}`)));
      }

      // --- turns ----------------------------------------------------------------
      // ACP has no steering: messages sent mid-turn wait and go out together when it ends.
      let busy = false;
      let cancelled = false;
      let queued: Array<{ text: string; attachments: ReadonlyArray<Attachment> }> = [];
      let preamble = fresh ? instructionsPreamble(options) : "";
      const images = caps.promptCapabilities?.image === true;

      const blocks = (text: string, attachments: ReadonlyArray<Attachment>) => {
        const out: Array<Record<string, unknown>> = [];
        if (images) {
          for (const a of attachments.filter(isImageAttachment)) {
            try {
              out.push({ type: "image", mimeType: a.mime, data: readFileSync(a.path).toString("base64") });
            } catch {
              // fall back to the path in the note
            }
          }
        }
        out.push({ type: "text", text: preamble + text + attachmentNote(attachments) });
        preamble = "";
        return out;
      };

      const runTurn = (text: string, attachments: ReadonlyArray<Attachment>): Effect.Effect<void> =>
        Effect.gen(function* () {
          busy = true;
          cancelled = false;
          yield* event({ _tag: "TurnStarted" });
          const outcome = yield* rpc.request("session/prompt", { sessionId, prompt: blocks(text, attachments) }).pipe(
            Effect.map((r) => {
              const stop = (r as { stopReason?: string } | null)?.stopReason;
              if (stop === "cancelled" || cancelled) return { outcome: "interrupted" as const, error: null };
              if (stop === "refusal") return { outcome: "failed" as const, error: `${agent.name} refused to continue` };
              return { outcome: "completed" as const, error: null };
            }),
            Effect.catch((error) => Effect.succeed(cancelled ? { outcome: "interrupted" as const, error: null } : { outcome: "failed" as const, error: error.message })),
          );
          yield* flush;
          busy = false;
          yield* event({ _tag: "TurnCompleted", ...outcome });
          if (queued.length > 0 && outcome.outcome !== "interrupted") {
            const next = queued;
            queued = [];
            yield* runTurn(next.map((m) => m.text).join("\n\n"), next.flatMap((m) => m.attachments));
          }
          queued = [];
        });

      return {
        send: (text: string, attachments: ReadonlyArray<Attachment> = []) =>
          Effect.suspend(() => {
            if (busy) {
              queued.push({ text, attachments });
              return Effect.void;
            }
            busy = true;
            return runTurn(text, attachments).pipe(Effect.forkIn(scope), Effect.asVoid);
          }),
        interrupt: Effect.suspend(() => {
          if (!busy) return Effect.void;
          cancelled = true;
          queued = [];
          return Effect.andThen(
            rpc.notify("session/cancel", { sessionId }),
            // Pending permission requests are answered "cancelled" by the agent's own cancel.
            Effect.forEach([...pendingApprovals.values()], (d) => Deferred.succeed(d, "decline"), { discard: true }),
          );
        }),
        respondApproval: (requestId: string, decision: ApprovalDecision) =>
          Effect.suspend(() => {
            const deferred = pendingApprovals.get(requestId);
            return deferred ? Deferred.succeed(deferred, decision).pipe(Effect.asVoid) : Effect.fail(fail(`unknown approval request ${requestId}`));
          }),
        respondInput: inputs.respond,
        // Skills are listed in the first message; new ones show up in the next conversation.
        reloadSkills: Effect.void,
        compact: (instructions: string) =>
          Effect.suspend(() =>
            commands.some((c) => c.name === "compact")
              ? Effect.suspend(() => {
                  if (busy) return Effect.fail(fail(`${agent.name} is busy; compact when the turn ends`));
                  busy = true;
                  return runTurn(`/compact${instructions ? ` ${instructions}` : ""}`, []).pipe(Effect.forkIn(scope), Effect.asVoid);
                })
              : Effect.fail(fail(`${agent.name} cannot compact its context on request`)),
          ),
        commands: Effect.sync(() => commands),
      };
    }),
  };
};
