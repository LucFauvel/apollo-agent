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
} from "./Provider.ts";

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
  | { readonly type: string; readonly id: string };

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

export const makeCodexProvider = (config: CodexProviderConfig = {}): Provider => ({
  kind: "codex",
  listModels: listCodexModels(config),
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

    const onNotification = (method: string, params: unknown): Effect.Effect<void> => {
      const p = params as Record<string, unknown>;
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
        case "thread/tokenUsage/updated": {
          // `total` is the thread's running total; Codex reports no cost.
          const total = (p.tokenUsage as { total: CodexTokens }).total;
          const cached = Math.min(total.cachedInputTokens, total.inputTokens);
          return emit({
            _tag: "UsageTotals",
            totals: {
              inputTokens: total.inputTokens - cached,
              cachedInputTokens: cached,
              outputTokens: total.outputTokens,
              costUsd: 0,
            },
          });
        }
        case "item/agentMessage/delta":
          return agent({
            _tag: "AssistantDelta",
            itemId: p.itemId as string,
            text: p.delta as string,
          });
        case "item/started": {
          const event = toolStart(p.item as CodexItem);
          return event ? agent(event) : Effect.void;
        }
        case "item/completed": {
          const event = itemCompleted(p.item as CodexItem);
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

    const rpc = yield* spawnJsonRpcProcess({
      command: config.executable ?? "codex",
      args: ["app-server"],
      cwd: options.cwd,
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
      approvalPolicy: options.runtimeMode === "full-access" ? "never" : "on-request",
      sandbox: options.runtimeMode === "full-access" ? "danger-full-access" : "workspace-write",
      developerInstructions: options.instructions,
      ...(options.mcp
        ? {
            config: {
              [`mcp_servers.${options.mcp.name}`]: {
                url: options.mcp.url,
                http_headers: { Authorization: `Bearer ${options.mcp.bearerToken}` },
              },
            },
          }
        : {}),
    };

    const started = options.resumeId
      ? yield* call("thread/resume", { threadId: options.resumeId, excludeTurns: true, ...threadParams })
      : yield* call("thread/start", threadParams);
    threadId = (started as { thread: { id: string } }).thread.id;
    yield* emit({ _tag: "ResumeId", resumeId: threadId });

    const input = (text: string) => [{ type: "text", text, text_elements: [] }];

    return {
      send: (text: string) =>
        // Steer the running turn so mid-turn messages are folded in, like Claude's queue.
        activeTurnId !== null
          ? call("turn/steer", { threadId, expectedTurnId: activeTurnId, input: input(text) }).pipe(
              Effect.asVoid,
            )
          : call("turn/start", {
              threadId,
              input: input(text),
              ...(options.effort ? { effort: options.effort } : {}),
            }).pipe(Effect.asVoid),
      interrupt: Effect.suspend(() =>
        activeTurnId === null
          ? Effect.void
          : call("turn/interrupt", { threadId, turnId: activeTurnId }).pipe(Effect.asVoid),
      ),
      reloadSkills: setSkillRoots,
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
