import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
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
  type Attachment,
  attachmentNote,
  isImageAttachment,
} from "./Provider.ts";
import type { ConnectorInfo, InputField } from "@apollo/contracts";

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
  ) => Effect.Effect<
    {
      readonly model: string | null;
      readonly env: Environment;
      /** Put before Apollo's instructions, e.g. which model actually answers. */
      readonly instructions?: string;
    },
    ProviderError,
    Scope.Scope
  >;
  /** Claude Code prices tokens as Anthropic models; a local backend costs nothing. */
  readonly free: boolean;
  /** Auto mode's reviewer for tool calls the rules cannot settle; answers `ask` when unsure. */
  readonly review?: (call: {
    readonly tool: string;
    readonly input: unknown;
    readonly cwd: string;
    readonly task: string;
  }) => Effect.Effect<"allow" | "ask">;
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
const CLAUDE_STATUS: Record<string, ConnectorInfo["status"]> = {
  connected: "connected",
  "needs-auth": "needs-auth",
  failed: "failed",
  disabled: "disabled",
  pending: "pending",
};

/**
 * MCP servers and claude.ai connectors a Claude Code session loads, from a session that
 * never gets a prompt. Servers connect in the background, so it waits (up to ~20 s)
 * until none is still pending. `includeClaudeAi: false` for backends that do not use
 * the user's claude.ai login (llama.cpp), whose sessions cannot load those.
 */
const listClaudeConnectors = (config: ClaudeProviderConfig, fail: (message: string) => ProviderError, includeClaudeAi: boolean) =>
  Effect.flatMap(config.environment ?? Effect.succeed(null), (env) =>
    Effect.tryPromise({
      try: async () => {
        const inbox = makeAsyncInbox<SDKUserMessage>();
        const abort = new AbortController();
        const q = query({
          prompt: inbox,
          options: {
            abortController: abort,
            cwd: homedir(),
            settingSources: ["user", "project", "local"],
            permissionMode: "default",
            ...withEnvironment(env),
            ...(config.executable ? { pathToClaudeCodeExecutable: config.executable } : {}),
          },
        });
        try {
          let status = await q.mcpServerStatus();
          for (let i = 0; i < 20 && status.some((s) => s.status === "pending"); i++) {
            await new Promise((r) => setTimeout(r, 1000));
            status = await q.mcpServerStatus();
          }
          return status;
        } finally {
          inbox.close();
          q.close();
        }
      },
      catch: (cause) => fail(`listing connectors failed: ${errorMessage(cause)}`),
    }),
  ).pipe(
    Effect.timeout("45 seconds"),
    Effect.mapError((error) => (error instanceof ProviderError ? error : fail("listing connectors timed out"))),
    Effect.map((servers) =>
      servers
        .filter((s) => includeClaudeAi || s.scope !== "claudeai")
        .map(
          (s): ConnectorInfo => ({
            name: s.scope === "claudeai" ? s.name.replace(/^claude\.ai /, "") : s.name,
            kind: s.scope === "claudeai" ? "connector" : "mcp",
            status: CLAUDE_STATUS[s.status] ?? "failed",
            tools: s.tools ? s.tools.length : null,
          }),
        ),
    ),
  );

interface AskedQuestion {
  readonly question: string;
  readonly header?: string;
  readonly multiSelect?: boolean;
  readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
}

const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch", "Skill",
  "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskStop", "ListMcpResourcesTool", "ReadMcpResourceTool",
  "ReadMcpResourceDirTool", "EnterPlanMode", "ExitPlanMode", "Agent", "Monitor", "LSP",
]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** Shell commands auto mode never runs without asking. */
const RISKY_COMMAND =
  /\b(sudo|su|mkfs|dd\s+if=|shutdown|reboot|chmod\s+-R\s+777|chown\s+-R)\b|\brm\s+-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME|\*)|git\s+push\b[^\n]*--force|git\s+push\b[^\n]*\s-f\b|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|npm\s+publish|pnpm\s+publish|yarn\s+publish|cargo\s+publish|(curl|wget)[^|\n]*\|\s*(sh|bash|zsh)|>\s*\/dev\/(sd|disk)|launchctl|security\s+delete|kill\s+-9\s+1\b/i;
/** Connector / MCP actions that change or send something. */
const RISKY_ACTION = /(send|post|delete|remove|publish|merge|transfer|pay|purchase|create|update|write|edit|move|archive|invite|share|reply|comment)/i;

/**
 * Auto mode for backends without Claude Code's classifier (local llama.cpp models), first
 * pass: `allow` reading, edits in the workspace, Apollo's own tools and ordinary shell
 * commands; `ask` about clearly risky commands; `unsure` for the rest (edits elsewhere,
 * connector actions that change or send something, unknown tools), which a reviewer model
 * may settle, or else the user.
 */
export const autoDecision = (toolName: string, input: Record<string, unknown>, cwd: string): "allow" | "ask" | "unsure" => {
  if (READ_ONLY_TOOLS.has(toolName)) return "allow";
  if (EDIT_TOOLS.has(toolName)) {
    const path = String(input.file_path ?? input.notebook_path ?? "");
    return path === "" || !path.startsWith("/") || path.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`) ? "allow" : "unsure";
  }
  if (toolName === "Bash" || toolName === "PowerShell") return RISKY_COMMAND.test(String(input.command ?? "")) ? "ask" : "allow";
  if (toolName.startsWith("mcp__apollo__")) return "allow";
  if (toolName.startsWith("mcp__")) return RISKY_ACTION.test(toolName.split("__").pop() ?? "") ? "unsure" : "allow";
  return "unsure";
};

/** Rules only: allowed without asking. */
export const autoApprove = (toolName: string, input: Record<string, unknown>, cwd: string) =>
  autoDecision(toolName, input, cwd) === "allow";

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
  listConnectors: listClaudeConnectors(config, fail, config.backend === undefined),
  open: Effect.fn("ClaudeProvider.open")(function* (options: ProviderSessionOptions, emit: Emit) {
    const backend = config.backend
      ? yield* config.backend.prepare(options.model)
      : { model: options.model, env: config.environment ? yield* config.environment : null, instructions: undefined };
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

    /** The user's latest message, for the reviewer's context. */
    let lastUserText = "";
    const canUseTool: CanUseTool = (toolName, input, { signal }) =>
      Effect.runPromiseWith(context)(
        Effect.gen(function* () {
          // Claude Code's questions for the user are answered, not approved.
          if (toolName === "AskUserQuestion") return yield* askUser(input, signal);
          // Auto mode behind a backend without Claude Code's classifier (llama.cpp): Apollo's rules
          // decide, and its reviewer model (if the user set one) settles what they cannot.
          if (options.runtimeMode === "auto" && config.backend) {
            const rule = autoDecision(toolName, input, options.cwd);
            const verdict =
              rule === "unsure" && config.backend.review
                ? yield* config.backend.review({ tool: toolName, input, cwd: options.cwd, task: lastUserText })
                : rule;
            if (verdict === "allow") return { behavior: "allow", updatedInput: input } satisfies PermissionResult;
          }
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

    /** AskUserQuestion as an input card: one choice field per question, plus a free-text answer. */
    const askUser = (input: Record<string, unknown>, signal: AbortSignal) =>
      Effect.gen(function* () {
        const questions = (input.questions ?? []) as ReadonlyArray<AskedQuestion>;
        const requestId = `claude-question-${++inputCounter}`;
        signal.addEventListener("abort", () => run(inputs.cancel(requestId)));
        const response = yield* inputs.ask(requestId, {
          source: "Question from the agent",
          message: questions.length === 1 ? questions[0]!.question : "The agent has a few questions.",
          url: null,
          fields: questions.flatMap((q, i): Array<InputField> => [
            {
              name: `q${i}`,
              kind: q.multiSelect ? "multi-select" : "select",
              title: questions.length === 1 ? (q.header ?? "Answer") : q.question,
              description: questions.length === 1 ? "" : (q.header ?? ""),
              required: false,
              options: (q.options ?? []).map((o) => ({ value: o.label, label: o.description ? `${o.label} — ${o.description}` : o.label })),
              default: null,
              secret: false,
            },
            {
              name: `q${i}_other`,
              kind: "string",
              title: "Or answer in your own words",
              description: "",
              required: false,
              options: [],
              default: null,
              secret: false,
            },
          ]),
        });
        if (response.action !== "accept") {
          return { behavior: "deny", message: "The user dismissed the question without answering." } satisfies PermissionResult;
        }
        const answers: Record<string, string> = {};
        questions.forEach((q, i) => {
          const own = response.values[`q${i}_other`];
          const picked = response.values[`q${i}`];
          const value =
            typeof own === "string" && own.trim()
              ? own.trim()
              : Array.isArray(picked)
                ? picked.join(", ")
                : typeof picked === "string"
                  ? picked
                  : "";
          if (value) answers[q.question] = value;
        });
        return { behavior: "allow", updatedInput: { ...input, answers } } satisfies PermissionResult;
      });
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
      ...(options.extraDirectories?.length ? { additionalDirectories: [...options.extraDirectories] } : {}),
      abortController: abort,
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: backend.instructions ? `${backend.instructions}\n\n${options.instructions}` : options.instructions,
      },
      ...(backend.model ? { model: backend.model } : {}),
      ...withEnvironment(backend.env),
      ...(options.effort ? { effort: options.effort as EffortLevel } : {}),
      ...(options.resumeId ? { resume: options.resumeId } : {}),
      ...(config.executable ? { pathToClaudeCodeExecutable: config.executable } : {}),
      ...(options.runtimeMode === "full-access"
        ? { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }
        : // Auto: Claude Code's classifier decides; what it cannot decide still reaches canUseTool.
          { permissionMode: options.runtimeMode === "auto" ? "auto" : "default", canUseTool }),
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

    /** Asks Claude Code how full the context window is (cheap: from the last response). */
    const reportContext: Effect.Effect<void> = Effect.suspend(() =>
      Effect.tryPromise(() => session.getContextUsage({ detail: "summary" })).pipe(
        Effect.flatMap((usage) =>
          usage.maxTokens > 0 ? emit({ _tag: "ContextUsage", used: usage.totalTokens, window: usage.maxTokens }) : Effect.void,
        ),
        Effect.ignore,
      ),
    );

    const handle = (message: SDKMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        switch (message.type) {
          case "system": {
            if (message.subtype === "init") {
              yield* emit({ _tag: "ResumeId", resumeId: message.session_id });
            } else if (message.subtype === "compact_boundary") {
              const meta = (message as { compact_metadata?: { trigger?: string; pre_tokens?: number } }).compact_metadata;
              yield* agent({
                _tag: "Notice",
                level: "info",
                message: `${meta?.trigger === "auto" ? "Context was nearly full, so it was compacted automatically" : "Context compacted"}${meta?.pre_tokens ? ` (was ${Math.round(meta.pre_tokens / 1000)}k tokens)` : ""}. Earlier messages are now summarized for the agent.`,
              });
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
              const start = ev.content_block;
              // Show a tool call as soon as the model starts writing it, not once its input is complete.
              if (start.type === "tool_use" || start.type === "mcp_tool_use") {
                yield* agent({ _tag: "ToolPending", itemId: start.id, name: start.name });
              }
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
                yield* agent({
                  _tag: "ReasoningDelta",
                  itemId: `${currentMessageId}:${ev.index}`,
                  text: ev.delta.thinking,
                });
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
            // Before TurnCompleted, so the session is up to date once it reads as idle.
            yield* reportContext;
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
      send: (text: string, attachments: ReadonlyArray<Attachment> = []) =>
        Effect.gen(function* () {
          lastUserText = text;
          if (!inTurn) {
            inTurn = true;
            yield* agent({ _tag: "TurnStarted" });
          }
          // Images go to the model as image blocks; every attachment is also listed by path.
          const images = attachments.filter(isImageAttachment);
          const imageBlocks = yield* Effect.forEach(images, (a) =>
            Effect.tryPromise({
              try: async () => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: (a.mime === "image/jpg" ? "image/jpeg" : a.mime) as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                  data: (await readFile(a.path)).toString("base64"),
                },
              }),
              catch: (cause) => fail(`could not read ${a.name}: ${errorMessage(cause)}`),
            }),
          );
          const body = text + attachmentNote(attachments);
          inbox.push({
            type: "user",
            message: { role: "user", content: imageBlocks.length > 0 ? [...imageBlocks, { type: "text", text: body }] : body },
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
      compact: (instructions: string) =>
        Effect.gen(function* () {
          if (!inTurn) {
            inTurn = true;
            yield* agent({ _tag: "TurnStarted" });
          }
          // Claude Code runs its own /compact when it arrives as a message.
          inbox.push({
            type: "user",
            message: { role: "user", content: `/compact${instructions.trim() ? ` ${instructions.trim()}` : ""}` },
            parent_tool_use_id: null,
            origin: { kind: "human" },
          });
        }),
      commands: Effect.tryPromise({
        try: () => session.supportedCommands(),
        catch: (cause) => fail(`listing commands failed: ${errorMessage(cause)}`),
      }).pipe(Effect.map((list) => list.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })))),
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
