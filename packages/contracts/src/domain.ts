import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const BotId = Schema.String.pipe(Schema.brand("BotId"));
export type BotId = typeof BotId.Type;

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const MemoryId = Schema.String.pipe(Schema.brand("MemoryId"));
export type MemoryId = typeof MemoryId.Type;

export const SkillId = Schema.String.pipe(Schema.brand("SkillId"));
export type SkillId = typeof SkillId.Type;

/** Epoch milliseconds. */
export const Timestamp = Schema.Number;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const ProviderKind = Schema.Literals(["claude", "codex"]);
export type ProviderKind = typeof ProviderKind.Type;

/**
 * - `full-access`: the agent runs tools without asking.
 * - `approval-required`: risky tool calls surface as approval requests in the UI.
 */
export const RuntimeMode = Schema.Literals(["full-access", "approval-required"]);
export type RuntimeMode = typeof RuntimeMode.Type;

export const ProviderSelection = Schema.Struct({
  provider: ProviderKind,
  /** Provider-specific model id. Omitted means the provider's default. */
  model: Schema.optional(Schema.String),
});
export type ProviderSelection = typeof ProviderSelection.Type;

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

/**
 * A bot is a long-lived persona that owns a main (orchestrator) session plus
 * any number of worker sessions, each of which may use a different provider.
 */
export const Bot = Schema.Struct({
  id: BotId,
  name: Schema.String,
  /** Persona / standing instructions injected into every session the bot owns. */
  instructions: Schema.String,
  /** Default working directory for sessions. */
  cwd: Schema.String,
  /** Provider used by the bot's main session. */
  main: ProviderSelection,
  /** Default provider for worker sessions the bot spawns. */
  defaultWorker: ProviderSelection,
  runtimeMode: RuntimeMode,
  /** Run a reflection pass after sessions to extract memories and skill proposals. */
  autoLearn: Schema.Boolean,
  mainSessionId: SessionId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Bot = typeof Bot.Type;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * - `main`: the bot's orchestrator conversation (one per bot).
 * - `worker`: a task session the user or the bot created.
 * - `reflection`: an automatic learning pass over another session.
 */
export const SessionRole = Schema.Literals(["main", "worker", "reflection"]);
export type SessionRole = typeof SessionRole.Type;

export const SessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "waiting-approval",
  "error",
  "closed",
]);
export type SessionStatus = typeof SessionStatus.Type;

export const Session = Schema.Struct({
  id: SessionId,
  botId: BotId,
  role: SessionRole,
  /** The session that spawned this one (the bot's main session, or the reflected session). */
  parentSessionId: Schema.NullOr(SessionId),
  title: Schema.String,
  provider: ProviderKind,
  model: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  status: SessionStatus,
  /** Provider-native id used to resume the conversation (Claude session id / Codex thread id). */
  resumeId: Schema.NullOr(Schema.String),
  /** Last assistant message, kept for list views and orchestration tools. */
  lastMessage: Schema.NullOr(Schema.String),
  completedTurns: Schema.Number,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Session = typeof Session.Type;

// ---------------------------------------------------------------------------
// Normalized agent events (provider-agnostic)
// ---------------------------------------------------------------------------

export const MessageAuthor = Schema.Literals(["user", "bot", "system"]);
export type MessageAuthor = typeof MessageAuthor.Type;

export const ApprovalDecision = Schema.Literals(["accept", "accept-for-session", "decline"]);
export type ApprovalDecision = typeof ApprovalDecision.Type;

/**
 * Structured input an agent (usually one of its MCP servers) asks the user for:
 * MCP elicitations and Codex's request_user_input.
 */
export const InputFieldKind = Schema.Literals(["string", "number", "integer", "boolean", "select", "multi-select"]);
export type InputFieldKind = typeof InputFieldKind.Type;

export const InputValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)]);
export type InputValue = typeof InputValue.Type;

export const InputField = Schema.Struct({
  name: Schema.String,
  kind: InputFieldKind,
  title: Schema.String,
  description: Schema.String,
  required: Schema.Boolean,
  /** Choices for `select` / `multi-select`. */
  options: Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String })),
  default: Schema.NullOr(InputValue),
  /** Mask the value while typing (passwords, tokens). */
  secret: Schema.Boolean,
});
export type InputField = typeof InputField.Type;

export const InputAction = Schema.Literals(["accept", "decline", "cancel"]);
export type InputAction = typeof InputAction.Type;

export const InputResponse = Schema.Struct({
  action: InputAction,
  /** Field values keyed by `InputField.name`; ignored unless `action` is accept. */
  values: Schema.Record(Schema.String, InputValue),
});
export type InputResponse = typeof InputResponse.Type;

export const TurnOutcome = Schema.Literals(["completed", "interrupted", "failed"]);
export type TurnOutcome = typeof TurnOutcome.Type;

export const AgentEvent = Schema.Union([
  Schema.TaggedStruct("UserMessage", {
    text: Schema.String,
    /** Who sent it: the human, the orchestrating bot, or Apollo itself. */
    author: MessageAuthor,
  }),
  Schema.TaggedStruct("TurnStarted", {}),
  Schema.TaggedStruct("AssistantDelta", { itemId: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("AssistantMessage", { itemId: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("Reasoning", { itemId: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("ToolStarted", {
    itemId: Schema.String,
    name: Schema.String,
    /** Short human-readable summary of the call (command, file path, ...). */
    summary: Schema.String,
  }),
  Schema.TaggedStruct("ToolCompleted", {
    itemId: Schema.String,
    output: Schema.String,
    isError: Schema.Boolean,
  }),
  Schema.TaggedStruct("ApprovalRequested", {
    requestId: Schema.String,
    title: Schema.String,
    detail: Schema.String,
  }),
  Schema.TaggedStruct("ApprovalResolved", {
    requestId: Schema.String,
    decision: ApprovalDecision,
  }),
  Schema.TaggedStruct("InputRequested", {
    requestId: Schema.String,
    /** Who is asking, e.g. an MCP server name. */
    source: Schema.String,
    message: Schema.String,
    /** Set for URL-mode requests: the user completes them in a browser. */
    url: Schema.NullOr(Schema.String),
    fields: Schema.Array(InputField),
  }),
  Schema.TaggedStruct("InputResolved", {
    requestId: Schema.String,
    action: InputAction,
  }),
  Schema.TaggedStruct("TurnCompleted", {
    outcome: TurnOutcome,
    error: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("Notice", {
    level: Schema.Literals(["info", "warning", "error"]),
    message: Schema.String,
  }),
]);
export type AgentEvent = typeof AgentEvent.Type;

/** An agent event as persisted in a session's append-only log. */
export const SessionEvent = Schema.Struct({
  sessionId: SessionId,
  seq: Schema.Number,
  at: Timestamp,
  event: AgentEvent,
});
export type SessionEvent = typeof SessionEvent.Type;

// ---------------------------------------------------------------------------
// Memory & skills (shared across providers)
// ---------------------------------------------------------------------------

export const MemoryKind = Schema.Literals(["fact", "preference", "lesson"]);
export type MemoryKind = typeof MemoryKind.Type;

export const Memory = Schema.Struct({
  id: MemoryId,
  /** `null` means global: visible to every bot. */
  botId: Schema.NullOr(BotId),
  kind: MemoryKind,
  content: Schema.String,
  tags: Schema.Array(Schema.String),
  /** Session that produced it, when learned automatically or saved by an agent. */
  sourceSessionId: Schema.NullOr(SessionId),
  createdAt: Timestamp,
  /** Last time a search returned it; compaction evicts the least used first. */
  lastUsedAt: Schema.NullOr(Timestamp),
});
export type Memory = typeof Memory.Type;

/**
 * Core memory: small, curated notes that are always in every session's prompt.
 * `user` (about the user) is shared by all bots; `notes` belong to one bot. Each
 * has a character budget, so agents must consolidate instead of piling up.
 * Everything else goes to the searchable memory archive.
 */
export const CoreMemoryTarget = Schema.Literals(["user", "notes"]);
export type CoreMemoryTarget = typeof CoreMemoryTarget.Type;

export const CORE_MEMORY_LIMITS: Record<CoreMemoryTarget, number> = { user: 1375, notes: 2200 };

export const CoreMemory = Schema.Struct({
  user: Schema.Array(Schema.String),
  notes: Schema.Array(Schema.String),
});
export type CoreMemory = typeof CoreMemory.Type;

/** Characters an entry list uses against its budget (entries are newline-separated). */
export const coreMemoryUsage = (entries: ReadonlyArray<string>): number =>
  entries.reduce((sum, e) => sum + e.length, 0) + Math.max(entries.length - 1, 0);

/** Disk usage and what compaction last did. */
export const StorageReport = Schema.Struct({
  databaseBytes: Schema.Number,
  budgetBytes: Schema.Number,
  memories: Schema.Number,
  sessions: Schema.Number,
  events: Schema.Number,
  lastCompactedAt: Schema.NullOr(Timestamp),
});
export type StorageReport = typeof StorageReport.Type;

/**
 * - `proposed`: written by an agent or a reflection pass, awaiting review.
 * - `active`: advertised to sessions.
 * - `archived`: kept for history, not advertised.
 */
export const SkillStatus = Schema.Literals(["proposed", "active", "archived"]);
export type SkillStatus = typeof SkillStatus.Type;

export const Skill = Schema.Struct({
  id: SkillId,
  botId: Schema.NullOr(BotId),
  /** kebab-case, unique per bot scope. */
  name: Schema.String,
  /** One line: when to use this skill. */
  description: Schema.String,
  /** SKILL.md body (markdown instructions). */
  body: Schema.String,
  status: SkillStatus,
  version: Schema.Number,
  sourceSessionId: Schema.NullOr(SessionId),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Skill = typeof Skill.Type;

// ---------------------------------------------------------------------------
// Device pairing
// ---------------------------------------------------------------------------

export const ClientId = Schema.String.pipe(Schema.brand("ClientId"));
export type ClientId = typeof ClientId.Type;

/**
 * - `pairing-link`: redeemed a one-time pairing link.
 * - `desktop`: the desktop app's per-launch bootstrap token.
 */
export const ClientMethod = Schema.Literals(["pairing-link", "desktop"]);
export type ClientMethod = typeof ClientMethod.Type;

/** A device or client authorized to use this server. */
export const PairedClient = Schema.Struct({
  id: ClientId,
  label: Schema.String,
  method: ClientMethod,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  lastSeenAt: Timestamp,
});
export type PairedClient = typeof PairedClient.Type;

export const PairingToken = Schema.Struct({
  /** One-time secret. Put it in a URL fragment (`/pair#token=…`) so it is never logged. */
  token: Schema.String,
  expiresAt: Timestamp,
});
export type PairingToken = typeof PairingToken.Type;

/** `GET /api/auth/session` response. */
export const AuthStatus = Schema.Struct({
  authenticated: Schema.Boolean,
  clientId: Schema.NullOr(ClientId),
  label: Schema.NullOr(Schema.String),
});
export type AuthStatus = typeof AuthStatus.Type;

/** `POST /api/auth/pair` request. */
export const PairRequest = Schema.Struct({
  token: Schema.String,
  label: Schema.String,
  /** Return the session token in the body (CLI clients) instead of only setting a cookie. */
  bearer: Schema.optional(Schema.Boolean),
});
export type PairRequest = typeof PairRequest.Type;

export const PairResponse = Schema.Struct({
  clientId: ClientId,
  sessionToken: Schema.NullOr(Schema.String),
});
export type PairResponse = typeof PairResponse.Type;
