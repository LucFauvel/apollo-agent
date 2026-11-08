import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ApprovalDecision } from "@apollo/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { fieldsFromSchema, makeInputRequests } from "./InputRequests.ts";
import { JsonRpcFailure, spawnJsonRpcProcess } from "./JsonRpcProcess.ts";
import {
  type Emit,
  type Provider,
  ProviderError,
  type ProviderSessionOptions,
  summarizeToolInput,
  truncate,
  type Attachment,
  attachmentNote,
  isImageAttachment,
} from "./Provider.ts";
import type { ConnectorInfo } from "@apollo/contracts";

const fail = (message: string) => new ProviderError({ provider: "codex", message });

// Minimal views of the `codex app-server` v2 protocol. Generate the full
// bindings with `codex app-server generate-ts --out <dir>` when extending.
interface CodexTokens {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

interface CodexQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly isOther: boolean;
  readonly isSecret: boolean;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }> | null;
}

interface CodexTurn {
  readonly id: string;
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
  readonly error: { readonly message: string } | null;
}
type CodexItem =
  | { readonly type: "agentMessage"; readonly id: string; readonly text: string }
  | { readonly type: "reasoning"; readonly id: string; readonly summary: ReadonlyArray<string> }
  | {
      readonly type: "commandExecution";
      readonly id: string;
      readonly command: string;
      readonly aggregatedOutput: string | null;
      readonly exitCode: number | null;
    }
  | {
      readonly type: "fileChange";
      readonly id: string;
      readonly changes: ReadonlyArray<{ readonly path: string; readonly kind: unknown }>;
      readonly status: string;
    }
  | {
      readonly type: "mcpToolCall";
      readonly id: string;
      readonly server: string;
      readonly tool: string;
      readonly arguments: unknown;
      readonly result: unknown;
      readonly error: { readonly message?: string } | null;
    }
  | { readonly type: "webSearch"; readonly id: string; readonly query?: string }
  | {
      /** A subagent started, was talked to, stopped or finished (reported in the thread that owns it). */
      readonly type: "subAgentActivity";
      readonly id: string;
      readonly kind: "started" | "interacted" | "interrupted" | "completed";
      readonly agentThreadId: string;
      readonly agentPath: string;
    }
  | {
      /** spawn / wait / send input / close ... on subagents. */
      readonly type: "collabAgentToolCall";
      readonly id: string;
      readonly tool: string;
      readonly status: "inProgress" | "completed" | "failed" | "interrupted";
      readonly receiverThreadIds: ReadonlyArray<string>;
      readonly prompt: string | null;
      readonly agentsStates: Record<string, { readonly status: string; readonly message: string | null } | undefined>;
    }
  | { readonly type: string; readonly id: string };

/** `spawnAgent` → "spawn", `sendInput` → "send input". */
const collabVerb = (tool: string) =>
  tool
    .replace(/Agent$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

/** A subagent's name from its path: `/root/list_files` → "list files". */
const agentName = (path: string) => (path.split("/").filter(Boolean).at(-1) ?? path).replace(/_/g, " ");

const toolStart = (item: CodexItem): AgentEvent | null => {
  switch (item.type) {
    case "commandExecution": {
      const it = item as Extract<CodexItem, { type: "commandExecution" }>;
      return { _tag: "ToolStarted", itemId: it.id, name: "shell", summary: truncate(it.command, 200) };
    }
    case "fileChange": {
      const it = item as Extract<CodexItem, { type: "fileChange" }>;
      return {
        _tag: "ToolStarted",
        itemId: it.id,
        name: "edit",
        summary: truncate(it.changes.map((c) => c.path).join(", "), 200),
      };
    }
    case "mcpToolCall": {
      const it = item as Extract<CodexItem, { type: "mcpToolCall" }>;
      return {
        _tag: "ToolStarted",
        itemId: it.id,
        name: `${it.server}.${it.tool}`,
        summary: summarizeToolInput(it.arguments),
      };
    }
    case "webSearch": {
      const it = item as Extract<CodexItem, { type: "webSearch" }>;
      return { _tag: "ToolStarted", itemId: it.id, name: "web_search", summary: it.query ?? "" };
    }
    default:
      return null;
  }
};

const itemCompleted = (item: CodexItem): AgentEvent | null => {
  switch (item.type) {
    case "agentMessage": {
      const it = item as Extract<CodexItem, { type: "agentMessage" }>;
      return { _tag: "AssistantMessage", itemId: it.id, text: it.text };
    }
    case "reasoning": {
      const it = item as Extract<CodexItem, { type: "reasoning" }>;
      const text = it.summary.join("\n\n");
      return text.length > 0 ? { _tag: "Reasoning", itemId: it.id, text } : null;
    }
    case "commandExecution": {
      const it = item as Extract<CodexItem, { type: "commandExecution" }>;
      return {
        _tag: "ToolCompleted",
        itemId: it.id,
        output: truncate(it.aggregatedOutput ?? "", 4000),
        isError: it.exitCode !== null && it.exitCode !== 0,
      };
    }
    case "fileChange": {
      const it = item as Extract<CodexItem, { type: "fileChange" }>;
      return {
        _tag: "ToolCompleted",
        itemId: it.id,
        output: it.changes.map((c) => c.path).join("\n"),
        isError: it.status === "failed" || it.status === "declined",
      };
    }
    case "mcpToolCall": {
      const it = item as Extract<CodexItem, { type: "mcpToolCall" }>;
      return {
        _tag: "ToolCompleted",
        itemId: it.id,
        output: truncate(
          it.error ? (it.error.message ?? "MCP tool failed") : JSON.stringify(it.result ?? null),
          4000,
        ),
        isError: it.error !== null,
      };
    }
    case "webSearch":
      return { _tag: "ToolCompleted", itemId: item.id, output: "", isError: false };
    default:
      return null;
  }
};

const toCodexDecision = (decision: ApprovalDecision) =>
  decision === "accept" ? "accept" : decision === "accept-for-session" ? "acceptForSession" : "decline";

export interface CodexProviderConfig {
  /** `codex` executable; defaults to `codex` on PATH. */
  readonly executable?: string | undefined;
}

interface CodexModel {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly isDefault: boolean;
  readonly supportedReasoningEfforts: ReadonlyArray<{ readonly reasoningEffort: string }>;
  readonly defaultReasoningEffort: string | null;
}

/** Starts a short-lived `codex app-server` to ask which models it offers. */
const listCodexModels = (config: CodexProviderConfig) =>
  Effect.gen(function* () {
    const rpc = yield* spawnJsonRpcProcess({
      command: config.executable ?? "codex",
      args: ["app-server"],
      cwd: homedir(),
      handlers: {
        onNotification: () => Effect.void,
        onRequest: (method) => Effect.fail(new JsonRpcFailure({ message: `Apollo does not handle ${method}` })),
        onExit: () => Effect.void,
      },
    }).pipe(Effect.mapError((error) => fail(error.message)));
    const call = (method: string, params: unknown) =>
      rpc.request(method, params).pipe(Effect.mapError((error) => fail(`${method}: ${error.message}`)));
    yield* call("initialize", { clientInfo: { name: "apollo", title: "Apollo", version: "0.0.0" }, capabilities: null });
    yield* rpc.notify("initialized", {});

    const models: Array<CodexModel> = [];
    let cursor: string | null = null;
    do {
      const page = (yield* call("model/list", { cursor, limit: 100 })) as {
        data: Array<CodexModel>;
        nextCursor: string | null;
      };
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== null);

    return models
      .filter((m) => !m.hidden)
      .map((m) => ({
        id: m.model,
        label: m.displayName,
        description: m.description,
        isDefault: m.isDefault,
        efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
        defaultEffort: m.defaultReasoningEffort,
      }));
  }).pipe(Effect.scoped, Effect.timeout("30 seconds"), Effect.mapError((e) => (e instanceof ProviderError ? e : fail("listing models timed out"))));

const CODEX_STATUS: Record<string, ConnectorInfo["status"]> = {
  connected: "connected",
  starting: "pending",
  notStarted: "pending",
  authenticationRequired: "needs-auth",
  failed: "failed",
  cancelled: "failed",
  disabled: "disabled",
};

/** MCP servers (from ~/.codex/config.toml and plugins) and ChatGPT apps Codex sessions load. */
const listCodexConnectors = (config: CodexProviderConfig) =>
  Effect.gen(function* () {
    const rpc = yield* spawnJsonRpcProcess({
      command: config.executable ?? "codex",
      args: ["app-server"],
      cwd: homedir(),
      handlers: {
        onNotification: () => Effect.void,
        onRequest: (method) => Effect.fail(new JsonRpcFailure({ message: `Apollo does not handle ${method}` })),
        onExit: () => Effect.void,
      },
    }).pipe(Effect.mapError((error) => fail(error.message)));
    const call = (method: string, params: unknown) =>
      rpc.request(method, params).pipe(Effect.mapError((error) => fail(`${method}: ${error.message}`)));
    yield* call("initialize", { clientInfo: { name: "apollo", title: "Apollo", version: "0.0.0" }, capabilities: null });
    yield* rpc.notify("initialized", {});

    const out: Array<ConnectorInfo> = [];
    let cursor: string | null = null;
    do {
      const page = (yield* call("mcpServerStatus/list", { cursor, limit: 100, detail: "toolsAndAuthOnly" })) as {
        data: Array<{ name: string; runtimeStatus: string | null; tools?: Record<string, unknown> | null }>;
        nextCursor: string | null;
      };
      for (const s of page.data) {
        // codex_apps hosts the ChatGPT apps listed below.
        if (s.name === "codex_apps") continue;
        const tools = s.tools ? Object.keys(s.tools).length : null;
        // Servers only start with a conversation; one whose tools are known is available.
        const status = CODEX_STATUS[s.runtimeStatus ?? ""] ?? "pending";
        out.push({ name: s.name, kind: "mcp", status: status === "pending" && tools ? "connected" : status, tools });
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    // ChatGPT apps (connectors); an account without them answers with an error.
    const apps = (yield* call("app/installed", {}).pipe(Effect.orElseSucceed(() => ({ apps: [] })))) as {
      apps: Array<{ id: string; runtimeName: string | null; enabled: boolean; callable: boolean }>;
    };
    for (const app of apps.apps ?? []) {
      out.push({
        name: app.runtimeName ?? app.id,
        kind: "connector",
        status: !app.enabled ? "disabled" : app.callable ? "connected" : "needs-auth",
        tools: null,
      });
    }
    return out;
  }).pipe(
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.mapError((e) => (e instanceof ProviderError ? e : fail("listing connectors timed out"))),
  );

export const makeCodexProvider = (config: CodexProviderConfig = {}): Provider => ({
  kind: "codex",
  listModels: listCodexModels(config),
  listConnectors: listCodexConnectors(config),
  open: Effect.fn("CodexProvider.open")(function* (options: ProviderSessionOptions, emit: Emit) {
    const agent = (event: AgentEvent) => emit({ _tag: "Event", event });
    const pendingApprovals = new Map<string, Deferred.Deferred<ApprovalDecision>>();
    let threadId: string | null = null;
    let activeTurnId: string | null = null;

    const awaitApproval = (requestId: string, title: string, detail: string) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<ApprovalDecision>();
        pendingApprovals.set(requestId, deferred);
        yield* agent({ _tag: "ApprovalRequested", requestId, title, detail });
        const decision = yield* Deferred.await(deferred);
        pendingApprovals.delete(requestId);
        yield* agent({ _tag: "ApprovalResolved", requestId, decision });
        return decision;
      });

    const decisionResponse = (decision: ApprovalDecision) => ({ decision: toCodexDecision(decision) });

    const inputs = makeInputRequests(agent, fail);
    let inputCounter = 0;

    // --- subagents ------------------------------------------------------------
    // Codex runs each subagent as a thread of its own, on this same connection: its turns
    // are not the session's turns, and its messages are its report, not the agent's reply.
    // Its tool calls are shown under the "Subagent" step that started it.

    /** Subagents by thread id: their step in the conversation and their latest message. */
    const subagents = new Map<string, { step: string; lastMessage: string }>();
    /** Items already shown (Codex reports some on both item/started and item/completed). */
    const shown = new Set<string>();
    const once = (key: string, effect: Effect.Effect<void>) =>
      Effect.suspend(() => {
        if (shown.has(key)) return Effect.void;
        shown.add(key);
        return effect;
      });

    /** A subagent item, reported in thread `from` (the session's thread or another subagent's). */
    const subagentItem = (from: string, item: CodexItem): Effect.Effect<void> => {
      const parentItemId = from === threadId ? undefined : subagents.get(from)?.step;
      if (item.type === "subAgentActivity") {
        const it = item as Extract<CodexItem, { type: "subAgentActivity" }>;
        if (it.kind === "started") {
          subagents.set(it.agentThreadId, { step: it.id, lastMessage: "" });
          return once(
            it.id,
            agent({ _tag: "ToolStarted", itemId: it.id, name: "Agent", summary: agentName(it.agentPath), ...(parentItemId ? { parentItemId } : {}) }),
          );
        }
        const sub = subagents.get(it.agentThreadId);
        if (!sub || (it.kind !== "completed" && it.kind !== "interrupted")) return Effect.void;
        return once(
          `${sub.step}:done`,
          agent({ _tag: "ToolCompleted", itemId: sub.step, output: truncate(sub.lastMessage || "(no report)", 4000), isError: it.kind === "interrupted" }),
        );
      }
      // collabAgentToolCall
      const it = item as Extract<CodexItem, { type: "collabAgentToolCall" }>;
      const names = it.receiverThreadIds.map((id) => {
        const sub = subagents.get(id);
        return sub ? sub.step : id;
      });
      const started = once(
        it.id,
        agent({
          _tag: "ToolStarted",
          itemId: it.id,
          name: `Subagent ${collabVerb(it.tool)}`,
          summary: truncate(it.prompt ?? (names.length > 0 ? `${names.length} subagent${names.length === 1 ? "" : "s"}` : ""), 200),
          ...(parentItemId ? { parentItemId } : {}),
        }),
      );
      if (it.status === "inProgress") return started;
      const states = Object.values(it.agentsStates).flatMap((state) => (state ? [`${state.status}${state.message ? `: ${state.message}` : ""}`] : []));
      return Effect.andThen(
        started,
        once(
          `${it.id}:done`,
          agent({ _tag: "ToolCompleted", itemId: it.id, output: truncate(states.join("\n"), 4000), isError: it.status === "failed" }),
        ),
      );
    };

    /** A notification from a subagent's thread. */
    const fromSubagent = (from: string, method: string, p: Record<string, unknown>): Effect.Effect<void> => {
      const item = p.item as CodexItem | undefined;
      if (!item || (method !== "item/started" && method !== "item/completed")) return Effect.void;
      if (item.type === "subAgentActivity" || item.type === "collabAgentToolCall") return subagentItem(from, item);
      const sub = subagents.get(from);
      if (item.type === "agentMessage") {
        if (sub && method === "item/completed") sub.lastMessage = (item as Extract<CodexItem, { type: "agentMessage" }>).text;
        return Effect.void;
      }
      if (item.type === "reasoning") return Effect.void;
      const event = method === "item/started" ? toolStart(item) : itemCompleted(item);
      if (!event) return Effect.void;
      return agent(event._tag === "ToolStarted" && sub ? { ...event, parentItemId: sub.step } : event);
    };

    const onNotification = (method: string, params: unknown): Effect.Effect<void> => {
      const p = params as Record<string, unknown>;
      const from = typeof p.threadId === "string" ? p.threadId : null;
      if (from !== null && threadId !== null && from !== threadId) return fromSubagent(from, method, p);
      switch (method) {
        case "turn/started": {
          activeTurnId = (p.turn as CodexTurn).id;
          return agent({ _tag: "TurnStarted" });
        }
        case "turn/completed": {
          const turn = p.turn as CodexTurn;
          activeTurnId = null;
          return agent({
            _tag: "TurnCompleted",
            outcome: turn.status === "inProgress" ? "completed" : turn.status,
            error: turn.error?.message ?? null,
          });
        }
        case "thread/compacted":
          return agent({
            _tag: "Notice",
            level: "info",
            message: "Context compacted. Earlier messages are now summarized for the agent.",
          });
        case "thread/tokenUsage/updated": {
          // `total` is the thread's running total; Codex reports no cost.
          const usage = p.tokenUsage as { total: CodexTokens; last: CodexTokens & { totalTokens?: number }; modelContextWindow: number | null };
          const total = usage.total;
          // `last` is the latest request: what the context holds now.
          const context =
            usage.modelContextWindow && usage.last
              ? emit({
                  _tag: "ContextUsage",
                  used: usage.last.totalTokens ?? usage.last.inputTokens + usage.last.outputTokens,
                  window: usage.modelContextWindow,
                })
              : Effect.void;
          const cached = Math.min(total.cachedInputTokens, total.inputTokens);
          return Effect.andThen(
            context,
            emit({
              _tag: "UsageTotals",
              totals: {
                inputTokens: total.inputTokens - cached,
                cachedInputTokens: cached,
                outputTokens: total.outputTokens,
                costUsd: 0,
              },
            }),
          );
        }
        case "item/agentMessage/delta":
          return agent({
            _tag: "AssistantDelta",
            itemId: p.itemId as string,
            text: p.delta as string,
          });
        case "item/started": {
          const item = p.item as CodexItem;
          if (item.type === "contextCompaction") return agent({ _tag: "Compacting", active: true });
          if (item.type === "subAgentActivity" || item.type === "collabAgentToolCall") return subagentItem(threadId ?? "", item);
          const event = toolStart(item);
          return event ? agent(event) : Effect.void;
        }
        case "item/completed": {
          const item = p.item as CodexItem;
          if (item.type === "contextCompaction") return agent({ _tag: "Compacting", active: false });
          if (item.type === "subAgentActivity" || item.type === "collabAgentToolCall") return subagentItem(threadId ?? "", item);
          const event = itemCompleted(item);
          return event ? agent(event) : Effect.void;
        }
        case "error": {
          if (p.willRetry === true) return Effect.void;
          const error = p.error as { message?: string } | undefined;
          return agent({ _tag: "Notice", level: "error", message: error?.message ?? "Codex error" });
        }
        default:
          return Effect.void;
      }
    };

    const onRequest = (method: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      switch (method) {
        case "item/commandExecution/requestApproval":
          return awaitApproval(
            `codex-${p.itemId as string}-${(p.approvalId as string | null) ?? "cmd"}`,
            "Run command?",
            String(p.command ?? p.reason ?? ""),
          ).pipe(Effect.map(decisionResponse));
        case "item/fileChange/requestApproval":
          return awaitApproval(
            `codex-${p.itemId as string}-patch`,
            "Apply file changes?",
            String(p.reason ?? (p.grantRoot ? `write access to ${p.grantRoot}` : "")),
          ).pipe(Effect.map(decisionResponse));
        case "item/permissions/requestApproval": {
          // Codex asks for extra sandbox permissions (network / filesystem).
          // Granting returns the requested profile; declining grants nothing.
          const requested = (p.permissions ?? {}) as Record<string, unknown>;
          const granted = Object.fromEntries(
            Object.entries(requested).filter(([, value]) => value !== null && value !== undefined),
          );
          return awaitApproval(
            `codex-${p.itemId as string}-permissions`,
            "Grant extra permissions?",
            [p.reason, JSON.stringify(granted, null, 2)].filter(Boolean).join("\n"),
          ).pipe(
            Effect.map((decision) =>
              decision === "decline"
                ? { permissions: {}, scope: "turn" }
                : { permissions: granted, scope: decision === "accept-for-session" ? "session" : "turn" },
            ),
          );
        }
        case "mcpServer/elicitation/request": {
          if (options.readOnly) return Effect.succeed({ action: "decline", content: null, _meta: null });
          // An MCP server wants a form filled in, or a URL visited (e.g. OAuth).
          const isUrl = p.mode === "url";
          return inputs
            .ask(`codex-input-${++inputCounter}`, {
              source: String(p.serverName ?? "MCP server"),
              message: String(p.message ?? ""),
              url: isUrl ? String(p.url ?? "") : null,
              fields: isUrl ? [] : fieldsFromSchema(p.requestedSchema),
            })
            .pipe(
              Effect.map(({ action, values }) => ({
                action,
                content: action === "accept" && !isUrl ? values : null,
                _meta: null,
              })),
            );
        }
        case "item/tool/requestUserInput": {
          if (options.readOnly) return Effect.succeed({ answers: {} });
          // Codex's own request_user_input tool: a few questions, optionally multiple choice.
          const questions = (p.questions ?? []) as ReadonlyArray<CodexQuestion>;
          return inputs
            .ask(`codex-${p.itemId as string}-input`, {
              source: "Codex",
              message: questions.length === 1 ? questions[0]!.question : "Codex has some questions.",
              url: null,
              fields: questions.map((q) => ({
                name: q.id,
                kind: q.options && q.options.length > 0 && !q.isOther ? "select" : "string",
                title: q.header || q.id,
                description: [
                  questions.length === 1 ? "" : q.question,
                  q.isOther && q.options ? `Options: ${q.options.map((o) => o.label).join(", ")}` : "",
                ]
                  .filter(Boolean)
                  .join("\n"),
                required: true,
                options: (q.options ?? []).map((o) => ({ value: o.label, label: o.label })),
                default: null,
                secret: q.isSecret,
              })),
            })
            .pipe(
              Effect.map(({ action, values }) => ({
                answers:
                  action === "accept"
                    ? Object.fromEntries(
                        Object.entries(values).map(([id, value]) => [
                          id,
                          { answers: Array.isArray(value) ? value : [String(value)] },
                        ]),
                      )
                    : {},
              })),
            );
        }
        default:
          return Effect.fail(new JsonRpcFailure({ message: `Apollo does not handle ${method}` }));
      }
    };

    // Another account: Codex runs from that account's folder (CODEX_HOME).
    const env = options.environment
      ? Object.fromEntries(Object.entries({ ...process.env, ...options.environment }).filter(([, v]) => v !== undefined))
      : undefined;
    const rpc = yield* spawnJsonRpcProcess({
      command: config.executable ?? "codex",
      args: ["app-server"],
      cwd: options.cwd,
      ...(env ? { env } : {}),
      handlers: {
        onNotification,
        onRequest,
        onExit: (reason) => emit({ _tag: "Exited", reason }),
      },
    }).pipe(Effect.mapError((error) => fail(error.message)));

    const call = (method: string, params: unknown) =>
      rpc.request(method, params).pipe(Effect.mapError((error) => fail(`${method}: ${error.message}`)));

    yield* call("initialize", {
      clientInfo: { name: "apollo", title: "Apollo", version: "0.0.0" },
      capabilities: null,
    });
    yield* rpc.notify("initialized", {});

    const setSkillRoots = options.skillsPluginDir
      ? call("skills/extraRoots/set", { extraRoots: [join(options.skillsPluginDir, "skills")] }).pipe(
          Effect.andThen(call("skills/list", { cwds: [options.cwd], forceReload: true })),
          Effect.asVoid,
        )
      : Effect.void;
    yield* setSkillRoots;

    const threadParams = {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      // A read-only session (a reflection) never asks anything and cannot write.
      approvalPolicy: options.readOnly || options.runtimeMode === "full-access" ? "never" : "on-request",
      sandbox: options.readOnly ? "read-only" : options.runtimeMode === "full-access" ? "danger-full-access" : "workspace-write",
      // Auto: Codex's reviewer agent decides approval requests instead of the user.
      ...(options.runtimeMode === "auto" ? { approvalsReviewer: "auto_review" } : {}),
      developerInstructions: options.instructions,
      config: {
        ...(options.mcp
          ? {
              [`mcp_servers.${options.mcp.name}`]: {
                url: options.mcp.url,
                http_headers: { Authorization: `Bearer ${options.mcp.bearerToken}` },
              },
            }
          : {}),
        // The user's project folders are writable too, like the workspace.
        ...(options.extraDirectories?.length
          ? { "sandbox_workspace_write.writable_roots": [...options.extraDirectories] }
          : {}),
      },
    };

    const started = options.resumeId
      ? yield* call("thread/resume", { threadId: options.resumeId, excludeTurns: true, ...threadParams })
      : yield* call("thread/start", threadParams);
    threadId = (started as { thread: { id: string } }).thread.id;
    yield* emit({ _tag: "ResumeId", resumeId: threadId });

    const input = (text: string, attachments: ReadonlyArray<Attachment> = []) => [
      ...attachments.filter(isImageAttachment).map((a) => ({ type: "localImage", path: a.path })),
      { type: "text", text: text + attachmentNote(attachments), text_elements: [] },
    ];

    return {
      send: (text: string, attachments: ReadonlyArray<Attachment> = []) =>
        // Steer the running turn so mid-turn messages are folded in, like Claude's queue.
        activeTurnId !== null
          ? call("turn/steer", { threadId, expectedTurnId: activeTurnId, input: input(text, attachments) }).pipe(
              Effect.asVoid,
            )
          : call("turn/start", {
              threadId,
              input: input(text, attachments),
              ...(options.effort ? { effort: options.effort } : {}),
            }).pipe(Effect.asVoid),
      interrupt: Effect.suspend(() =>
        activeTurnId === null
          ? Effect.void
          : call("turn/interrupt", { threadId, turnId: activeTurnId }).pipe(Effect.asVoid),
      ),
      reloadSkills: setSkillRoots,
      // Codex's app server compacts on request; it reports back with thread/compacted.
      compact: () => call("thread/compact/start", { threadId }).pipe(Effect.asVoid),
      // Codex has no slash commands over its app server; Apollo's own commands still apply.
      commands: Effect.succeed([]),
      respondInput: inputs.respond,
      respondApproval: (requestId: string, decision: ApprovalDecision) =>
        Effect.gen(function* () {
          const deferred = pendingApprovals.get(requestId);
          if (!deferred) return yield* fail(`unknown approval request ${requestId}`);
          yield* Deferred.succeed(deferred, decision);
        }),
    };
  }),
});
