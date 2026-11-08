import * as Schema from "effect/Schema";
import { ProviderKind } from "./domain.ts";

/**
 * Something a provider's agents can reach beyond their own tools: a hosted connector
 * (claude.ai connectors, ChatGPT apps in Codex) or an MCP server the user configured.
 */
export const ConnectorInfo = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["connector", "mcp"]),
  status: Schema.Literals(["connected", "needs-auth", "failed", "disabled", "pending"]),
  /** Number of tools it offers, when known. */
  tools: Schema.NullOr(Schema.Number),
});
export type ConnectorInfo = typeof ConnectorInfo.Type;

/** Installed vs latest version of a provider's tool (Claude Code, Codex, llama.cpp). */
export const ProviderVersion = Schema.Struct({
  provider: ProviderKind,
  /** `null` when not installed (or bundled with Apollo, see `note`). */
  installed: Schema.NullOr(Schema.String),
  latest: Schema.NullOr(Schema.String),
  updateAvailable: Schema.Boolean,
  /** Apollo can run the update itself. */
  canUpdate: Schema.Boolean,
  note: Schema.NullOr(Schema.String),
});
export type ProviderVersion = typeof ProviderVersion.Type;
