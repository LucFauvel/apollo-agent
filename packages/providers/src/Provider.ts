import {
  type AgentEvent,
  type ApprovalDecision,
  type ConnectorInfo,
  type InputResponse,
  type ModelOption,
  ProviderKind,
  type RuntimeMode,
  type Usage,
} from "@apollo/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  provider: ProviderKind,
  message: Schema.String,
}) {}

/** An MCP server the provider should connect the agent to (Apollo's own). */
export interface McpEndpoint {
  readonly name: string;
  readonly url: string;
  readonly bearerToken: string;
}

export interface ProviderSessionOptions {
  readonly cwd: string;
  /** Folders outside `cwd` the agent may read and edit (the user's project folders). */
  readonly extraDirectories?: ReadonlyArray<string>;
  readonly model: string | null;
  /** Reasoning effort level; `null` uses the model's default. */
  readonly effort: string | null;
  /** Provider-native conversation id to resume, if any. */
  readonly resumeId: string | null;
  /** Extra instructions layered on top of the provider's own system prompt. */
  readonly instructions: string;
  readonly runtimeMode: RuntimeMode;
  readonly mcp: McpEndpoint | null;
  /**
   * Apollo's skills, laid out as a Claude Code plugin: `<dir>/.claude-plugin/plugin.json`
   * plus `<dir>/skills/<name>/SKILL.md`. Codex loads `<dir>/skills` as an extra skill root.
   */
  readonly skillsPluginDir: string | null;
  /**
   * A session that only reads and saves memories (a reflection): it may not ask the user
   * anything, edit files or run commands.
   */
  readonly readOnly?: boolean;
  /**
   * Extra environment for the agent's process, over the provider's own (e.g. the Claude
   * account a bot runs on: `CLAUDE_CONFIG_DIR`). `undefined` removes a variable.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** What an adapter reports back to the session manager. */
export type ProviderEmission =
  | { readonly _tag: "Event"; readonly event: AgentEvent }
  /** The provider assigned (or confirmed) its native conversation id. */
  | { readonly _tag: "ResumeId"; readonly resumeId: string }
  /**
   * Usage so far in this provider conversation. Cumulative, and it may include
   * turns from before a resume, so consumers record the difference.
   */
  | { readonly _tag: "UsageTotals"; readonly totals: Usage }
  /** How full the model's context window is now (tokens in the last request vs the window). */
  | { readonly _tag: "ContextUsage"; readonly used: number; readonly window: number }
  /** The underlying process/connection ended; the session must be reopened. */
  | { readonly _tag: "Exited"; readonly reason: string };

/** A slash command the provider's harness offers (Claude Code: built-in, custom and skills). */
export interface ProviderCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
}

export type Emit = (emission: ProviderEmission) => Effect.Effect<void>;

/**
 * A live connection to one provider conversation. Its lifetime is bound to the
 * `Scope` it was opened in: closing the scope stops the underlying process.
 */
/** A file the user attached to a message, saved on this machine. */
export interface Attachment {
  readonly path: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

/** Images providers can take as image input (others are passed as file paths). */
export const isImageAttachment = (a: Attachment) => /^image\/(png|jpe?g|gif|webp)$/.test(a.mime) && a.size <= 5 * 1024 * 1024;

/** A note listing attachments by path, so the agent can read them with its own tools. */
export const attachmentNote = (attachments: ReadonlyArray<Attachment>) =>
  attachments.length === 0
    ? ""
    : [
        "",
        "",
        `[Attached by the user — ${attachments.some(isImageAttachment) ? "images are included above; " : ""}read files from these paths:]`,
        ...attachments.map((a) => `- ${a.name} (${a.mime}, ${a.size} bytes): ${a.path}`),
      ].join("\n");

export interface ProviderSession {
  /** Starts a turn, or steers the running turn if the provider supports it. */
  readonly send: (text: string, attachments?: ReadonlyArray<Attachment>) => Effect.Effect<void, ProviderError>;
  readonly interrupt: Effect.Effect<void, ProviderError>;
  readonly respondApproval: (
    requestId: string,
    decision: ApprovalDecision,
  ) => Effect.Effect<void, ProviderError>;
  /** Answers an `InputRequested` event. */
  readonly respondInput: (requestId: string, response: InputResponse) => Effect.Effect<void, ProviderError>;
  /** Re-reads `skillsPluginDir` after Apollo rewrote it. */
  readonly reloadSkills: Effect.Effect<void, ProviderError>;
  /** Summarizes the conversation so far to free context (optional `instructions` on what to keep). */
  readonly compact: (instructions: string) => Effect.Effect<void, ProviderError>;
  /** The harness's own slash commands, sent as messages starting with `/`. */
  readonly commands: Effect.Effect<ReadonlyArray<ProviderCommand>, ProviderError>;
}

export interface Provider {
  readonly kind: ProviderKind;
  readonly open: (
    options: ProviderSessionOptions,
    emit: Emit,
  ) => Effect.Effect<ProviderSession, ProviderError, Scope.Scope>;
  /** Models the provider offers to this user (asks the CLI, so it takes a moment). */
  readonly listModels: Effect.Effect<ReadonlyArray<ModelOption>, ProviderError>;
  /**
   * Connectors and MCP servers its sessions load (asks the CLI without starting a
   * conversation, so it costs no tokens; takes a few seconds).
   */
  readonly listConnectors?: Effect.Effect<ReadonlyArray<ConnectorInfo>, ProviderError>;
}

/** Compact one-line description of a tool input for transcript display. */
export const summarizeToolInput = (input: unknown): string => {
  if (input === null || typeof input !== "object") return String(input ?? "");
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "title", "label"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return truncate(value, 200);
  }
  return truncate(JSON.stringify(input), 200);
};

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
