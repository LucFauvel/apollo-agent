import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { AgentEvent, ApprovalDecision, InputField, ModelOption, Usage } from "@apollo/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { bearer, findExecutable, instructionsPreamble } from "./AgentSupport.ts";
import { makeInputRequests } from "./InputRequests.ts";
import { JsonRpcFailure, spawnJsonRpcProcess } from "./JsonRpcProcess.ts";
import {
  type Attachment,
  attachmentNote,
  type Emit,
  type Provider,
  ProviderError,
  type ProviderSessionOptions,
  summarizeToolInput,
  truncate,
} from "./Provider.ts";

/**
 * Muse Code, Meta's coding agent, through `muse serve`: its own protocol ("MSP"), JSON-RPC
 * over stdio where state-changing calls carry a client-minted `commandId`. Sessions,
 * turns, items with streamed deltas, approvals and questions map onto Apollo's events.
 */

const fail = (message: string) => new ProviderError({ provider: "muse", message });
const HINT = "Install Muse Code and run `muse login`.";

export interface MuseProviderConfig {
  readonly executable?: string | undefined;
}

interface MuseItem {
  readonly itemId: string;
  readonly kind: string;
  readonly status?: string;
  readonly turnId?: string | null;
  readonly text?: string;
  readonly summary?: ReadonlyArray<string>;
  readonly tool?: string;
  readonly args?: string;
  readonly visibleOutput?: string;
  readonly commandText?: string;
  readonly exitCode?: number;
  readonly failureReason?: string;
  readonly objective?: string;
  readonly role?: string;
  readonly result?: { readonly summary: string; readonly text?: string };
}

interface MuseApproval {
  readonly approvalId: string;
  readonly toolName?: string;
  readonly rawArgs?: string;
  readonly currentRequirementId: unknown;
  readonly availableChoices: ReadonlyArray<{ readonly choiceId: string; readonly label?: string; readonly decision: string }>;
  readonly subject?: { readonly kind?: string; readonly command?: string; readonly path?: string; readonly host?: string; readonly target?: string };
}

interface MuseQuestion {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  readonly selection?: { readonly mode?: "single" | "multiple" };
}

const executable = (config: MuseProviderConfig) =>
  Effect.suspend(() => {
    const found = findExecutable(config.executable ? [config.executable, "muse"] : ["muse"]);
    return found ? Effect.succeed(found) : Effect.fail(fail(`Muse Code (\`muse\`) was not found. ${HINT}`));
  });

const spawnMuse = (
  config: MuseProviderConfig,
  args: ReadonlyArray<string>,
  cwd: string,
  handlers: Parameters<typeof spawnJsonRpcProcess>[0]["handlers"],
) =>
  Effect.gen(function* () {
    const command = yield* executable(config);
    const rpc = yield* spawnJsonRpcProcess({
      command,
      args: ["serve", ...args],
      cwd,
      env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" },
      handlers,
    }).pipe(Effect.mapError((e) => fail(`${e.message}. ${HINT}`)));
    const init = (yield* rpc
      .request("initialize", {
        clientInfo: { name: "apollo", title: "Apollo", version: "1" },
        capabilities: { requestedCapabilities: ["sessionMcp"] },
      })
      .pipe(Effect.mapError((e) => fail(`Muse Code did not start: ${e.message}`)))) as { grantedCapabilities?: ReadonlyArray<string> } | null;
    yield* rpc.notify("initialized", undefined);
    return { rpc, granted: init?.grantedCapabilities ?? [] };
  });

const effortList = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value.flatMap((v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? [String((v as Record<string, unknown>).id ?? (v as Record<string, unknown>).value ?? "")] : [])).filter(Boolean)
    : [];

const listMuseModels = (config: MuseProviderConfig) =>
  Effect.gen(function* () {
    const { rpc } = yield* spawnMuse(config, ["--disable-shell", "--disable-write", "--no-session-log"], tmpdir(), {
      onNotification: () => Effect.void,
      onRequest: (method) => Effect.fail(new JsonRpcFailure({ message: `Apollo does not handle ${method}` })),
      onExit: () => Effect.void,
    });
    const catalog = (yield* rpc.request("model/list", {}).pipe(Effect.mapError((e) => fail(`model/list: ${e.message}. ${HINT}`)))) as {
      models?: ReadonlyArray<{
        modelId: string;
        providerId?: string;
        displayLabel?: string;
        isDefault?: boolean;
        defaultReasoningEffort?: string | null;
        reasoningEffortVariants?: unknown;
      }>;
    };
    const seen = new Set<string>();
    return (catalog.models ?? []).flatMap((m): Array<ModelOption> => {
      if ((m.providerId && m.providerId !== "meta") || seen.has(m.modelId)) return [];
      seen.add(m.modelId);
      return [
        {
          id: m.modelId,
          label: m.displayLabel?.trim() || m.modelId,
          description: "",
          isDefault: m.isDefault === true,
          efforts: effortList(m.reasoningEffortVariants),
          defaultEffort: m.defaultReasoningEffort ?? null,
        },
      ];
    });
  }).pipe(
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.mapError((e) => (e instanceof ProviderError ? e : fail("Muse Code took too long to list its models"))),
  );

/** A Muse item's tool name as Apollo groups them. */
const toolName = (item: MuseItem) => {
  if (item.kind === "subagent") return "Agent";
  if (item.kind === "userShell" || /shell|bash|exec_command/i.test(item.tool ?? "")) return "shell";
  const tool = item.tool ?? item.kind;
  if (/write|edit|patch/i.test(tool)) return "edit";
  if (/web|browse|fetch/i.test(tool)) return "web fetch";
  return tool;
};

const toolSummary = (item: MuseItem) => {
  if (item.kind === "subagent") return truncate(item.objective || item.role || "", 200);
  if (item.commandText) return truncate(item.commandText, 200);
  if (item.args) {
    try {
      return summarizeToolInput(JSON.parse(item.args));
    } catch {
      return truncate(item.args, 200);
    }
  }
  return "";
};

const TOOL_ITEMS = new Set(["toolCall", "userShell", "subagent", "workflow"]);

export const makeMuseProvider = (config: MuseProviderConfig = {}): Provider => ({
  kind: "muse",
  listModels: listMuseModels(config),
  open: Effect.fn("MuseProvider.open")(function* (options: ProviderSessionOptions, emit: Emit) {
    const scope = yield* Effect.scope;
    const event = (e: AgentEvent) => emit({ _tag: "Event", event: e });
    const readOnly = options.readOnly === true;
    const full = options.runtimeMode === "full-access" && !readOnly;
    let sessionId = options.resumeId ?? randomUUID();
    let activeTurn: string | null = null;

    // Items as they stream: text so far, and which tool items were shown.
    const texts = new Map<string, string>();
    const shown = new Set<string>();
    const done = new Set<string>();
    const totals: { -readonly [K in keyof Usage]: Usage[K] } = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };

    const onItem = (method: string, item: MuseItem): Effect.Effect<void> => {
      const completed = method === "item/completed" || (item.status !== undefined && item.status !== "inProgress");
      switch (item.kind) {
        case "agentMessage":
          if (!completed || done.has(item.itemId)) return Effect.void;
          done.add(item.itemId);
          return event({ _tag: "AssistantMessage", itemId: item.itemId, text: item.text ?? texts.get(item.itemId) ?? "" });
        case "reasoning": {
          if (!completed || done.has(item.itemId)) return Effect.void;
          done.add(item.itemId);
          const text = item.summary?.join("\n\n") || item.text || texts.get(item.itemId) || "";
          return text ? event({ _tag: "Reasoning", itemId: item.itemId, text }) : Effect.void;
        }
        case "compaction":
          return event({ _tag: "Compacting", active: !completed });
        default: {
          if (!TOOL_ITEMS.has(item.kind)) return Effect.void;
          const start = shown.has(item.itemId)
            ? Effect.void
            : Effect.andThen(
                Effect.sync(() => shown.add(item.itemId)),
                event({ _tag: "ToolStarted", itemId: item.itemId, name: toolName(item), summary: toolSummary(item) }),
              );
          if (!completed || done.has(item.itemId)) return start;
          done.add(item.itemId);
          const failed = item.status === "failed" || (item.exitCode !== undefined && item.exitCode !== 0);
          const output = [item.failureReason, item.visibleOutput ?? item.result?.summary ?? item.text ?? ""].filter(Boolean).join("\n");
          return Effect.andThen(start, event({ _tag: "ToolCompleted", itemId: item.itemId, output: truncate(output, 4000), isError: failed }));
        }
      }
    };

    // --- approvals and questions ---------------------------------------------------
    const pendingApprovals = new Map<string, Deferred.Deferred<ApprovalDecision>>();
    const inputs = makeInputRequests(event, fail);
    const command = (method: string, params: Record<string, unknown>) =>
      rpc.request(method, { sessionId, commandId: randomUUID(), ...params }).pipe(Effect.mapError((e) => fail(`${method}: ${e.message}`)));

    const choose = (approval: MuseApproval, decisions: ReadonlyArray<string>) =>
      decisions.map((d) => approval.availableChoices.find((c) => c.decision === d)).find(Boolean) ?? null;

    const decide = (approval: MuseApproval, decisions: ReadonlyArray<string>) => {
      const choice = choose(approval, decisions);
      return choice
        ? command("approval/decide", { approvalId: approval.approvalId, requirementId: approval.currentRequirementId, choiceId: choice.choiceId }).pipe(
            Effect.catch((error) => event({ _tag: "Notice", level: "warning", message: error.message })),
          )
        : Effect.void;
    };

    const onApproval = (approval: MuseApproval) =>
      Effect.gen(function* () {
        if (readOnly) return yield* decide(approval, ["denied", "abort"]);
        if (full) return yield* decide(approval, ["approvedForSession", "approved"]);
        const requestId = `muse-${approval.approvalId}`;
        if (pendingApprovals.has(requestId)) return;
        const deferred = yield* Deferred.make<ApprovalDecision>();
        pendingApprovals.set(requestId, deferred);
        const subject = approval.subject ?? {};
        const isShell = /shell|command|exec/i.test(`${subject.kind ?? ""} ${approval.toolName ?? ""}`) || subject.command !== undefined;
        yield* event({
          _tag: "ApprovalRequested",
          requestId,
          title: isShell ? "Run command?" : subject.path ? "Edit files?" : `Allow ${approval.toolName ?? "this action"}?`,
          detail: subject.command ?? subject.path ?? subject.host ?? subject.target ?? approval.rawArgs ?? "",
        });
        const answer = yield* Deferred.await(deferred).pipe(Effect.ensuring(Effect.sync(() => pendingApprovals.delete(requestId))));
        yield* event({ _tag: "ApprovalResolved", requestId, decision: answer });
        yield* decide(
          approval,
          answer === "accept" ? ["approved", "approvedForSession"] : answer === "accept-for-session" ? ["approvedForSession", "approved"] : ["denied", "abort"],
        );
      });

    const onQuestion = (params: { userInputId: string; questions: ReadonlyArray<MuseQuestion> }) =>
      Effect.gen(function* () {
        if (readOnly) {
          return yield* command("userInput/cancel", { userInputId: params.userInputId, reason: "This session cannot ask the user." }).pipe(Effect.ignore);
        }
        const questions = params.questions ?? [];
        const fields: Array<InputField> = questions.map((q) => ({
          name: q.id,
          kind: q.options.length === 0 ? "string" : q.selection?.mode === "multiple" ? "multi-select" : "select",
          title: q.header || q.id,
          description: questions.length === 1 ? "" : q.question,
          required: true,
          options: q.options.map((o) => ({ value: o.label, label: o.label })),
          default: null,
          secret: false,
        }));
        const response = yield* inputs.ask(`muse-input-${params.userInputId}`, {
          source: "Muse Code",
          message: questions.length === 1 ? questions[0]!.question : "Muse Code has some questions.",
          url: null,
          fields,
        });
        if (response.action !== "accept") {
          return yield* command("userInput/cancel", { userInputId: params.userInputId, reason: "The user declined." }).pipe(Effect.ignore);
        }
        const answers = questions.map((q) => {
          const value = response.values[q.id];
          const values = Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)];
          const selected = values.filter((v) => q.options.some((o) => o.label === v));
          const free = values.filter((v) => !selected.includes(v)).join("\n");
          return {
            questionId: q.id,
            ...(selected.length ? (q.selection?.mode === "multiple" ? { selectedLabels: selected } : { selectedLabel: selected[0] }) : {}),
            ...(free ? (selected.length ? { note: free } : { freeText: free }) : {}),
          };
        });
        yield* command("userInput/answer", { userInputId: params.userInputId, answers }).pipe(
          Effect.catch((error) => event({ _tag: "Notice", level: "warning", message: error.message })),
        );
      });

    const onNotification = (method: string, params: unknown): Effect.Effect<void> => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (p.sessionId !== undefined && p.sessionId !== sessionId) return Effect.void;
      switch (method) {
        case "turn/started":
          activeTurn = typeof p.turnId === "string" ? p.turnId : activeTurn;
          return event({ _tag: "TurnStarted" });
        case "item/started":
        case "item/updated":
        case "item/completed":
          return onItem(method, p.item as MuseItem);
        case "item/delta": {
          const itemId = String(p.itemId ?? "");
          const delta = String(p.delta ?? "");
          const field = typeof p.field === "string" ? p.field : "text";
          if (!itemId || !delta) return Effect.void;
          texts.set(itemId, (texts.get(itemId) ?? "") + delta);
          if (field === "text") return event({ _tag: "AssistantDelta", itemId, text: delta });
          if (field.startsWith("summary.")) return event({ _tag: "ReasoningDelta", itemId, text: delta });
          return Effect.void;
        }
        case "turn/completed": {
          if (p.turnId === activeTurn) activeTurn = null;
          const terminal = String(p.terminal ?? "completed");
          const usage = p.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cachedTokens?: number } | undefined;
          const recordUsage = usage
            ? Effect.suspend(() => {
                const cached = usage.cacheReadTokens ?? usage.cachedTokens ?? 0;
                totals.inputTokens += Math.max(0, (usage.inputTokens ?? 0) - cached);
                totals.cachedInputTokens += cached;
                totals.outputTokens += usage.outputTokens ?? 0;
                return emit({ _tag: "UsageTotals", totals: { ...totals } });
              })
            : Effect.void;
          const error = (p.error as { message?: string } | undefined)?.message ?? (terminal === "failed" ? String(p.reason ?? "Muse Code failed") : null);
          return Effect.andThen(
            recordUsage,
            event({
              _tag: "TurnCompleted",
              outcome: terminal === "completed" ? "completed" : terminal === "cancelled" || terminal === "interrupted" ? "interrupted" : "failed",
              error: terminal === "completed" ? null : error,
            }),
          );
        }
        case "approval/requested":
          return onApproval(p as unknown as MuseApproval).pipe(Effect.forkIn(scope), Effect.asVoid);
        case "approval/resolved": {
          // Settled elsewhere (e.g. the turn ended): withdraw the card.
          const deferred = pendingApprovals.get(`muse-${String(p.approvalId)}`);
          return deferred ? Deferred.succeed(deferred, "decline").pipe(Effect.asVoid) : Effect.void;
        }
        case "userInput/requested":
          return onQuestion(p as never).pipe(Effect.forkIn(scope), Effect.asVoid);
        case "userInput/settled":
          return inputs.cancel(`muse-input-${String(p.userInputId)}`);
        case "session/contextUsage": {
          const used = Number(p.usedTokens);
          const window = Number(p.windowTokens);
          return Number.isFinite(used) && Number.isFinite(window) && window > 0 ? emit({ _tag: "ContextUsage", used, window }) : Effect.void;
        }
        default:
          return Effect.void;
      }
    };

    const args = ["--trust-workspace", ...(full ? ["--disable-sandbox"] : []), ...(readOnly ? ["--disable-shell", "--disable-write"] : [])];
    const { rpc, granted } = yield* spawnMuse(config, args, options.cwd, {
      onNotification,
      onRequest: (method) => Effect.fail(new JsonRpcFailure({ message: `Apollo does not handle ${method}` })),
      onExit: (reason) => emit({ _tag: "Exited", reason }),
    });

    const mcpConfig =
      options.mcp && granted.includes("sessionMcp")
        ? {
            config: {
              mcpServers: {
                [options.mcp.name]: { transport: "streamableHttp", mode: "optional", url: options.mcp.url, headers: { Authorization: bearer(options.mcp) } },
              },
            },
          }
        : {};
    if (options.mcp && !granted.includes("sessionMcp")) {
      yield* event({ _tag: "Notice", level: "warning", message: "This Muse Code version cannot load Apollo's tools; update Muse Code." });
    }
    const approvalMode = readOnly ? "denyUnmatched" : full ? "allowAll" : "promptUnmatched";
    const permissionProfile = full ? ":unrestricted" : ":ask-me";

    let fresh = true;
    if (options.resumeId) {
      const resumed = yield* command("session/resume", { excludeItems: true, ...mcpConfig, permissionProfile }).pipe(
        Effect.andThen(command("session/setApprovalMode", { mode: approvalMode })),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.as(event({ _tag: "Notice", level: "warning", message: `Muse Code could not reopen the conversation (${error.message}); starting a new one.` }), false),
        ),
      );
      if (resumed) fresh = false;
      else sessionId = randomUUID();
    }
    if (fresh) {
      const started = (yield* command("session/start", {
        workspaceRoot: options.cwd,
        ...mcpConfig,
        ...(options.model ? { modelId: options.model } : {}),
        providerId: "meta",
        approvalMode,
        permissionProfile,
      })) as { session?: { sessionId?: string } } | null;
      sessionId = started?.session?.sessionId ?? sessionId;
    }
    yield* emit({ _tag: "ResumeId", resumeId: sessionId });
    if (!fresh && options.model) yield* command("session/setModel", { modelId: options.model }).pipe(Effect.ignore);

    let preamble = fresh ? instructionsPreamble(options) : "";
    const turnStart = (text: string, attachments: ReadonlyArray<Attachment>) => {
      const commandId = randomUUID();
      const input = [...(preamble ? [{ type: "text", text: preamble }] : []), { type: "text", text: text + attachmentNote(attachments) }];
      preamble = "";
      return rpc
        .request("turn/start", {
          sessionId,
          commandId,
          input,
          displayText: text,
          workspaceRoots: [options.cwd, ...(options.extraDirectories ?? [])],
          // A message sent mid-turn waits for the turn to end.
          ifBusy: "queue",
          ...(options.effort ? { reasoningEffort: options.effort } : {}),
        })
        .pipe(
          Effect.tap((r) => Effect.sync(() => (activeTurn ??= (r as { turnId?: string } | null)?.turnId ?? commandId))),
          Effect.asVoid,
          Effect.mapError((e) => fail(`turn/start: ${e.message}`)),
        );
    };

    return {
      send: (text: string, attachments: ReadonlyArray<Attachment> = []) => turnStart(text, attachments),
      interrupt: Effect.suspend(() => (activeTurn ? command("turn/interrupt", { turnId: activeTurn }).pipe(Effect.asVoid) : Effect.void)),
      respondApproval: (requestId: string, decision: ApprovalDecision) =>
        Effect.suspend(() => {
          const deferred = pendingApprovals.get(requestId);
          return deferred ? Deferred.succeed(deferred, decision).pipe(Effect.asVoid) : Effect.fail(fail(`unknown approval request ${requestId}`));
        }),
      respondInput: inputs.respond,
      reloadSkills: Effect.void,
      compact: () => command("session/compact", {}).pipe(Effect.asVoid),
      commands: Effect.succeed([]),
    };
  }),
});
