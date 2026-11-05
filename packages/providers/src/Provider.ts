import {
  type AgentEvent,
  type ApprovalDecision,
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
  /** The underlying process/connection ended; the session must be reopened. */
  | { readonly _tag: "Exited"; readonly reason: string };

export type Emit = (emission: ProviderEmission) => Effect.Effect<void>;

/**
 * A live connection to one provider conversation. Its lifetime is bound to the
 * `Scope` it was opened in: closing the scope stops the underlying process.
 */
export interface ProviderSession {
  /** Starts a turn, or steers the running turn if the provider supports it. */
  readonly send: (text: string) => Effect.Effect<void, ProviderError>;
  readonly interrupt: Effect.Effect<void, ProviderError>;
  readonly respondApproval: (
    requestId: string,
    decision: ApprovalDecision,
  ) => Effect.Effect<void, ProviderError>;
  /** Answers an `InputRequested` event. */
  readonly respondInput: (requestId: string, response: InputResponse) => Effect.Effect<void, ProviderError>;
  /** Re-reads `skillsPluginDir` after Apollo rewrote it. */
  readonly reloadSkills: Effect.Effect<void, ProviderError>;
}

export interface Provider {
  readonly kind: ProviderKind;
  readonly open: (
    options: ProviderSessionOptions,
    emit: Emit,
  ) => Effect.Effect<ProviderSession, ProviderError, Scope.Scope>;
  /** Models the provider offers to this user (asks the CLI, so it takes a moment). */
  readonly listModels: Effect.Effect<ReadonlyArray<ModelOption>, ProviderError>;
}

/** Compact one-line description of a tool input for transcript display. */
export const summarizeToolInput = (input: unknown): string => {
  if (input === null || typeof input !== "object") return String(input ?? "");
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return truncate(value, 200);
  }
  return truncate(JSON.stringify(input), 200);
};

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
