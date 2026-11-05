import {
  query,
  type CanUseTool,
  type EffortLevel,
  type OnElicitation,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, ApprovalDecision, ModelOption, ProviderKind } from "@apollo/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeAsyncInbox } from "./AsyncInbox.ts";
import { fieldsFromSchema, makeInputRequests } from "./InputRequests.ts";
import {
  type Emit,
  type Provider,
  ProviderError,
  type ProviderSessionOptions,
  summarizeToolInput,
  truncate,
} from "./Provider.ts";

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Flattens a tool_result `content` field (string or content blocks) to text. */
const toolResultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string }) =>
        block.type === "text" && typeof block.text === "string" ? block.text : `[${block.type}]`,
      )
      .join("\n");
  }
  return "";
};

/**
 * Where Claude Code sends its model requests, when not to Anthropic: any server
 * that speaks the Anthropic Messages API (llama.cpp's llama-server, for one).
 */
export interface ClaudeBackend {
  readonly kind: ProviderKind;
  readonly listModels: Effect.Effect<ReadonlyArray<ModelOption>, ProviderError>;
  /**
   * Resolves the model a session runs and the environment that points Claude Code
   * at the backend. Runs each time a session opens.
   */
  readonly prepare: (
    model: string | null,
  ) => Effect.Effect<{ readonly model: string | null; readonly env: Environment }, ProviderError, Scope.Scope>;
  /** Claude Code prices tokens as Anthropic models; a local backend costs nothing. */
  readonly free: boolean;
}

/** Overrides for Claude Code's environment; `undefined` removes a variable. */
export type Environment = Record<string, string | undefined>;

export interface ClaudeProviderConfig {
  /** Override the `claude` executable (defaults to the one bundled with the SDK). */
  readonly executable?: string | undefined;
  /**
   * Environment overrides (credentials, for one), read each time Claude Code starts
   * so that settings changes apply to the next session.
   */
  readonly environment?: Effect.Effect<Environment, ProviderError> | undefined;
  readonly backend?: ClaudeBackend | undefined;
}

const withEnvironment = (env: Environment | null) => (env ? { env: { ...process.env, ...env } } : {});

/** Starts Claude Code without a prompt just to ask which models it offers. */
const listClaudeModels = (config: ClaudeProviderConfig, fail: (message: string) => ProviderError) =>
  Effect.flatMap(config.environment ?? Effect.succeed(null), (env) => Effect.tryPromise({
    try: async () => {
      const inbox = makeAsyncInbox<SDKUserMessage>();
      const abort = new AbortController();
      const q = query({
        prompt: inbox,
        options: {
          abortController: abort,
          settingSources: ["user"],
          ...withEnvironment(env),
          ...(config.executable ? { pathToClaudeCodeExecutable: config.executable } : {}),
        },
      });
      try {
        return await q.supportedModels();
      } finally {
        inbox.close();
        q.close();
      }
    },
    catch: (cause) => fail(`listing models failed: ${errorMessage(cause)}`),
  })).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((error) => (error instanceof ProviderError ? error : fail("listing models timed out"))),
    Effect.map((models) => {
      // Claude Code lists a "default" alias row; Apollo shows that as "no model chosen".
      const alias = models.find((m) => m.value === "default");
      return models.filter((m) => m !== alias).map((m) => ({
        id: m.value,
        label: m.displayName,
        description: m.description,
        isDefault: alias?.resolvedModel !== undefined && m.resolvedModel === alias.resolvedModel,
        efforts: m.supportsEffort ? [...(m.supportedEffortLevels ?? [])] : [],
        defaultEffort: null,
      }));
    }),
  );

export const makeClaudeProvider = (config: ClaudeProviderConfig = {}): Provider => {
  const kind = config.backend?.kind ?? "claude";
  const fail = (message: string) => new ProviderError({ provider: kind, message });
  return {
  kind,
  listModels: config.backend?.listModels ?? listClaudeModels(config, fail),
  open: Effect.fn("ClaudeProvider.open")(function* (options: ProviderSessionOptions, emit: Emit) {
    const backend = config.backend
      ? yield* config.backend.prepare(options.model)
      : { model: options.model, env: config.environment ? yield* config.environment : null };
    const context = yield* Effect.context<never>();
    const run = Effect.runForkWith(context);
    const agent = (event: AgentEvent) => emit({ _tag: "Event", event });

    const inbox = makeAsyncInbox<SDKUserMessage>();
    const abort = new AbortController();
    const pendingApprovals = new Map<string, Deferred.Deferred<ApprovalDecision>>();
    let approvalCounter = 0;

    // Per-turn bookkeeping used to normalize the SDK stream.
    let inTurn = false;
    let interruptRequested = false;
    const streamedMessageIds = new Set<string>();
    let currentMessageId: string | null = null;
    const blocks = new Map<number, { type: string; text: string }>();

    const canUseTool: CanUseTool = (toolName, input, { signal }) =>
      Effect.runPromiseWith(context)(
        Effect.gen(function* () {
          const requestId = `claude-approval-${++approvalCounter}`;
          const deferred = yield* Deferred.make<ApprovalDecision>();
          pendingApprovals.set(requestId, deferred);
          signal.addEventListener("abort", () => {
            run(Deferred.succeed(deferred, "decline"));
          });
          yield* agent({
            _tag: "ApprovalRequested",
            requestId,
            title: `Allow ${toolName}?`,
            detail: summarizeToolInput(input),
          });
          const decision = yield* Deferred.await(deferred);
          pendingApprovals.delete(requestId);
          yield* agent({ _tag: "ApprovalResolved", requestId, decision });
          const result: PermissionResult =
            decision === "decline"
              ? { behavior: "deny", message: "The user declined this tool call." }
              : { behavior: "allow", updatedInput: input };
          return result;
        }),
      );

    // MCP servers asking the user for input (forms, or a URL to complete in a browser).
    const inputs = makeInputRequests(agent, fail);
    let inputCounter = 0;
    const onElicitation: OnElicitation = (request, { signal }) => {
      const requestId = `claude-input-${++inputCounter}`;
      signal.addEventListener("abort", () => run(inputs.cancel(requestId)));
      return Effect.runPromiseWith(context)(
        inputs
          .ask(requestId, {
            source: request.displayName ?? request.serverName,
            message: [request.title, request.message].filter(Boolean).join("\n\n"),
            url: request.mode === "url" ? (request.url ?? null) : null,
            fields: request.mode === "url" ? [] : fieldsFromSchema(request.requestedSchema),
          })
          .pipe(
            Effect.map(({ action, values }) =>
              action === "accept" && request.mode !== "url" ? {
                    action,
                    content: Object.fromEntries(
                      Object.entries(values).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
                    ) as Record<string, string | number | boolean | Array<string>>,
                  } : { action },
            ),
          ),
      );
    };

    const sdkOptions: Options = {
      onElicitation,
      cwd: options.cwd,
      abortController: abort,
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code", append: options.instructions },
      ...(backend.model ? { model: backend.model } : {}),
      ...withEnvironment(backend.env),
      ...(options.effort ? { effort: options.effort as EffortLevel } : {}),
      ...(options.resumeId ? { resume: options.resumeId } : {}),
      ...(config.executable ? { pathToClaudeCodeExecutable: config.executable } : {}),
      ...(options.runtimeMode === "full-access"
        ? { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }
        : { permissionMode: "default", canUseTool }),
      ...(options.skillsPluginDir ? { plugins: [{ type: "local", path: options.skillsPluginDir }] } : {}),
      ...(options.mcp
        ? {
            mcpServers: {
              [options.mcp.name]: {
                type: "http",
                url: options.mcp.url,
                headers: { Authorization: `Bearer ${options.mcp.bearerToken}` },
                alwaysLoad: true,
              },
            },
          }
        : {}),
    };

    const session = yield* Effect.try({
      try: () => query({ prompt: inbox, options: sdkOptions }),
      catch: (cause) => fail(`failed to start Claude: ${errorMessage(cause)}`),
    });

    const handle = (message: SDKMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        switch (message.type) {
          case "system": {
            if (message.subtype === "init") {
              yield* emit({ _tag: "ResumeId", resumeId: message.session_id });
            }
            return;
          }
          case "stream_event": {
            if (message.parent_tool_use_id !== null) return;
            const ev = message.event;
            if (ev.type === "message_start") {
              currentMessageId = ev.message.id;
              streamedMessageIds.add(ev.message.id);
              blocks.clear();
            } else if (ev.type === "content_block_start") {
              blocks.set(ev.index, { type: ev.content_block.type, text: "" });
            } else if (ev.type === "content_block_delta") {
              const block = blocks.get(ev.index);
              if (!block || currentMessageId === null) return;
              if (ev.delta.type === "text_delta") {
                block.text += ev.delta.text;
                yield* agent({
                  _tag: "AssistantDelta",
                  itemId: `${currentMessageId}:${ev.index}`,
                  text: ev.delta.text,
                });
              } else if (ev.delta.type === "thinking_delta") {
                block.text += ev.delta.thinking;
              }
            } else if (ev.type === "content_block_stop") {
              const block = blocks.get(ev.index);
              if (!block || currentMessageId === null) return;
              const itemId = `${currentMessageId}:${ev.index}`;
              if (block.type === "text" && block.text.length > 0) {
                yield* agent({ _tag: "AssistantMessage", itemId, text: block.text });
              } else if (block.type === "thinking" && block.text.length > 0) {
                yield* agent({ _tag: "Reasoning", itemId, text: block.text });
              }
            }
            return;
          }
          case "assistant": {
            if (message.parent_tool_use_id !== null) return;
            const streamed = streamedMessageIds.has(message.message.id);
            for (const [index, block] of message.message.content.entries()) {
              if (block.type === "tool_use" || block.type === "mcp_tool_use") {
                yield* agent({
                  _tag: "ToolStarted",
                  itemId: block.id,
                  name: block.name,
                  summary: summarizeToolInput(block.input),
                });
              } else if (!streamed && block.type === "text") {
                // Fallback when partial messages were not streamed for this message.
                yield* agent({
                  _tag: "AssistantMessage",
                  itemId: `${message.message.id}:${index}`,
                  text: block.text,
                });
              }
            }
            return;
          }
          case "user": {
            if (message.parent_tool_use_id !== null) return;
            const content = message.message.content;
            if (typeof content === "string") return;
            for (const block of content) {
              if (block.type === "tool_result") {
                yield* agent({
                  _tag: "ToolCompleted",
                  itemId: block.tool_use_id,
                  output: truncate(toolResultText(block.content), 4000),
                  isError: block.is_error === true,
                });
              }
            }
            return;
          }
          case "result": {
            const outcome = interruptRequested
              ? "interrupted"
              : message.subtype === "success" && !message.is_error
                ? "completed"
                : "failed";
            const error =
              outcome !== "failed"
                ? null
                : message.subtype === "success"
                  ? message.result
                  : message.errors.join("\n") || message.subtype;
            interruptRequested = false;
            inTurn = false;
            // modelUsage covers subagents and internal calls too; both it and the
            // cost are running totals for the conversation.
            const models = Object.values(message.modelUsage ?? {});
            yield* emit({
              _tag: "UsageTotals",
              totals: {
                inputTokens: models.reduce((n, m) => n + m.inputTokens + m.cacheCreationInputTokens, 0),
                cachedInputTokens: models.reduce((n, m) => n + m.cacheReadInputTokens, 0),
                outputTokens: models.reduce((n, m) => n + m.outputTokens, 0),
                costUsd: config.backend?.free ? 0 : (message.total_cost_usd ?? 0),
              },
            });
            yield* agent({ _tag: "TurnCompleted", outcome, error });
            if ((message.queued_turn_count ?? 0) > 0) {
              inTurn = true;
              yield* agent({ _tag: "TurnStarted" });
            }
            return;
          }
          default:
            return;
        }
      });

    // Pump SDK output into the emitter for as long as the scope is open.
    yield* Stream.fromAsyncIterable(session, (cause) =>
      fail(`Claude stream failed: ${errorMessage(cause)}`),
    ).pipe(
      Stream.runForEach(handle),
      Effect.matchEffect({
        onFailure: (error) => emit({ _tag: "Exited", reason: error.message }),
        onSuccess: () => emit({ _tag: "Exited", reason: "Claude session ended" }),
      }),
      Effect.forkScoped,
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        inbox.close();
        abort.abort();
      }),
    );

    return {
      send: (text: string) =>
        Effect.gen(function* () {
          if (!inTurn) {
            inTurn = true;
            yield* agent({ _tag: "TurnStarted" });
          }
          inbox.push({
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
            origin: { kind: "human" },
          });
        }),
      interrupt: Effect.tryPromise({
        try: async () => {
          interruptRequested = true;
          await session.interrupt();
        },
        catch: (cause) => fail(`interrupt failed: ${errorMessage(cause)}`),
      }),
      reloadSkills: Effect.tryPromise({
        try: () => session.reloadSkills(),
        catch: (cause) => fail(`reloading skills failed: ${errorMessage(cause)}`),
      }).pipe(Effect.asVoid),
      respondInput: inputs.respond,
      respondApproval: (requestId: string, decision: ApprovalDecision) =>
        Effect.gen(function* () {
          const deferred = pendingApprovals.get(requestId);
          if (!deferred) return yield* fail(`unknown approval request ${requestId}`);
          yield* Deferred.succeed(deferred, decision);
        }),
    };
  }),
  };
};
