import * as Schema from "effect/Schema";
import { ChangeReport, RepoChanges } from "./changes.ts";

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

export const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"));
export type ProjectId = typeof ProjectId.Type;

/** Epoch milliseconds. */
export const Timestamp = Schema.Number;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * `llamacpp`: a local model behind llama.cpp's llama-server, driven by the Claude Code harness.
 * `cursor`, `grok`, `opencode`, `antigravity` and `copilot` (GitHub Copilot CLI) speak the Agent Client Protocol; `muse`
 * (Meta's Muse Code) and `pi` have protocols of their own.
 */
export const ProviderKind = Schema.Literals(["claude", "codex", "llamacpp", "cursor", "grok", "opencode", "antigravity", "muse", "pi", "copilot"]);
export type ProviderKind = typeof ProviderKind.Type;

/**
 * - `full-access`: the agent runs tools without asking.
 * - `approval-required`: risky tool calls surface as approval requests in the UI.
 * - `auto`: a reviewer model approves or denies risky tool calls (Claude Code's auto
 *   mode, Codex's auto review) and asks the user only when it cannot decide.
 */
export const RuntimeMode = Schema.Literals(["full-access", "approval-required", "auto"]);
export type RuntimeMode = typeof RuntimeMode.Type;

export const ProviderSelection = Schema.Struct({
  provider: ProviderKind,
  /** Provider-specific model id. Omitted means the provider's default. */
  model: Schema.optional(Schema.String),
  /** Reasoning effort level, as the provider names it (e.g. `high`). Omitted means the model's default. */
  effort: Schema.optional(Schema.String),
});
export type ProviderSelection = typeof ProviderSelection.Type;

/** A model a provider offers, as reported by the provider itself. */
export const ModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.String,
  /** Used when no model is chosen. */
  isDefault: Schema.Boolean,
  /** Reasoning effort levels the model accepts (empty when it has none). */
  efforts: Schema.Array(Schema.String),
  defaultEffort: Schema.NullOr(Schema.String),
});
export type ModelOption = typeof ModelOption.Type;

// ---------------------------------------------------------------------------
// Usage & guardrails
// ---------------------------------------------------------------------------

/** Token and cost totals. `costUsd` only counts providers that report a cost (Claude). */
export const Usage = Schema.Struct({
  /** Input tokens processed fresh (not read from the prompt cache). */
  inputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
  costUsd: Schema.Number,
});
export type Usage = typeof Usage.Type;

/**
 * One of a provider's plan meters (a usage window or spend cap), exactly as the provider
 * reported it. Apollo never estimates these: a provider that exposes none has none.
 */
export const UsageMeter = Schema.Struct({
  /** What it limits, worded for display: "Session (5 h)", "Weekly", "Weekly · Fable", "Spend limit". */
  label: Schema.String,
  /** Share of the meter used, 0-100. */
  usedPercent: Schema.Number,
  /** When it resets, if the provider says. */
  resetsAt: Schema.NullOr(Timestamp),
  /** The provider's own grading of it ("normal", "warning", "critical"), if it gives one. */
  severity: Schema.NullOr(Schema.String),
  /** The provider picked this one as the meter a single indicator shows. */
  headline: Schema.Boolean,
});
export type UsageMeter = typeof UsageMeter.Type;

/** A provider account's plan meters, and when they were read. */
export const UsageLimits = Schema.Struct({
  meters: Schema.Array(UsageMeter),
  at: Timestamp,
});
export type UsageLimits = typeof UsageLimits.Type;

/**
 * Plan limits belong to a provider account, not to a session: every session on the same
 * account shows its latest reading. The key is `<provider>:<account id>`, with `local` for
 * this machine's own login.
 */
export const limitsAccount = (
  provider: ProviderKind,
  bot: { readonly claudeAccountId: string | null; readonly codexAccountId: string | null },
): string => `${provider}:${(provider === "claude" ? bot.claudeAccountId : provider === "codex" ? bot.codexAccountId : null) ?? "local"}`;

/** The latest plan meters of one provider account (see `limitsAccount`). */
export const AccountLimits = Schema.Struct({
  account: Schema.String,
  limits: UsageLimits,
});
export type AccountLimits = typeof AccountLimits.Type;

/** The meter a single indicator shows: the provider's pick, else the fullest. */
export const headlineMeter = (meters: ReadonlyArray<UsageMeter>): UsageMeter | null =>
  meters.find((m) => m.headline) ?? meters.reduce<UsageMeter | null>((max, m) => (max && max.usedPercent >= m.usedPercent ? max : m), null);

export const EMPTY_USAGE: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };

/** "$12.34" for a dollar or more; two significant digits below ("$0.0034"). */
export const formatUsd = (usd: number): string =>
  usd >= 1 || usd === 0 ? `$${usd.toFixed(2)}` : `$${Number(usd.toPrecision(2))}`;

/** Tokens that count against a token budget: fresh input plus output. */
export const billableTokens = (usage: Usage) => usage.inputTokens + usage.outputTokens;

/**
 * Limits on what a bot does without the user. When one is hit the bot pauses:
 * automated work (spawning or messaging workers, worker reports, reflections)
 * is refused until the user resumes it. The user's own messages always go through.
 */
export const BotLimits = Schema.Struct({
  /** Workers that may run a turn at the same time. */
  maxConcurrentWorkers: Schema.Number,
  /** Orchestrator turns in a row not started by the user (e.g. reacting to worker reports). */
  maxAutonomousTurns: Schema.Number,
  /** Fresh input + output tokens per day, across all the bot's sessions. */
  dailyTokenBudget: Schema.NullOr(Schema.Number),
  /** Estimated spend per day; only providers that report cost count. */
  dailyCostBudgetUsd: Schema.NullOr(Schema.Number),
});
export type BotLimits = typeof BotLimits.Type;

export const DEFAULT_BOT_LIMITS: BotLimits = {
  maxConcurrentWorkers: 4,
  maxAutonomousTurns: 25,
  dailyTokenBudget: null,
  dailyCostBudgetUsd: null,
};

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

/** Shapes and colors of a bot's blob avatar. */
export const AVATAR_SHAPES = ["blob", "squircle", "ghost", "bean", "flower", "cloud", "star", "drop"] as const;
export const AVATAR_COLORS = ["coral", "sky", "mint", "grape", "sun", "ocean", "rose", "lime"] as const;
export const BotAvatar = Schema.Struct({
  shape: Schema.Literals(AVATAR_SHAPES),
  color: Schema.Literals(AVATAR_COLORS),
});
export type BotAvatar = typeof BotAvatar.Type;

/** A random avatar, for new bots. */
export const randomAvatar = (random: () => number = Math.random): BotAvatar => ({
  shape: AVATAR_SHAPES[Math.floor(random() * AVATAR_SHAPES.length)]!,
  color: AVATAR_COLORS[Math.floor(random() * AVATAR_COLORS.length)]!,
});

/** A stable avatar derived from a seed (bots created before avatars existed). */
export const seededAvatar = (seed: string): BotAvatar => {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const n = Math.abs(hash);
  return {
    shape: AVATAR_SHAPES[n % AVATAR_SHAPES.length]!,
    color: AVATAR_COLORS[Math.floor(n / AVATAR_SHAPES.length) % AVATAR_COLORS.length]!,
  };
};

/**
 * A bot is a long-lived persona that owns a main (orchestrator) session plus
 * any number of worker sessions, each of which may use a different provider.
 */
export const Bot = Schema.Struct({
  id: BotId,
  name: Schema.String,
  avatar: BotAvatar,
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
  limits: BotLimits,
  /** Why automated work is paused, or `null` when the bot runs freely. */
  pausedReason: Schema.NullOr(Schema.String),
  /**
   * The Claude account its Claude sessions use (one added in provider settings), or
   * `null` for this machine's own Claude login.
   */
  claudeAccountId: Schema.NullOr(Schema.String),
  /** The same for Codex sessions: an added Codex account, or `null` for this machine's login. */
  codexAccountId: Schema.NullOr(Schema.String),
  mainSessionId: SessionId,
  /**
   * Where the bot sits in the user's bot list: clients show bots sorted by it (then by
   * `createdAt`). Set by `bots.reorder`; new bots go last. Gaps are allowed.
   */
  position: Schema.Number,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Bot = typeof Bot.Type;

/** Bots in the user's order: by `position`, then by creation. */
export const sortBots = <B extends { readonly position: number; readonly createdAt: number; readonly id: string }>(bots: Iterable<B>): Array<B> =>
  [...bots].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

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

/** A worker's own git checkout: a worktree on its own branch (see `isolation: "worktree"`). */
export const SessionWorktree = Schema.Struct({
  /** The main checkout the worktree belongs to. */
  repoPath: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  /** Commit it started from, and the branch that was checked out then. */
  baseRef: Schema.String,
  baseBranch: Schema.NullOr(Schema.String),
});
export type SessionWorktree = typeof SessionWorktree.Type;

export const Session = Schema.Struct({
  id: SessionId,
  botId: BotId,
  role: SessionRole,
  /** The session that spawned this one (the bot's main session, or the reflected session). */
  parentSessionId: Schema.NullOr(SessionId),
  title: Schema.String,
  provider: ProviderKind,
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  /** Overrides the bot's runtime mode for this session; `null` follows the bot. */
  runtimeMode: Schema.NullOr(RuntimeMode),
  cwd: Schema.String,
  /** Its own git worktree, while it has one. */
  worktree: Schema.NullOr(SessionWorktree),
  /** The bot's project it works in (see `Project`). Optional: servers before projects omit it. */
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  /** How full the model's context window was after the last turn, when the provider reports it. */
  context: Schema.NullOr(Schema.Struct({ used: Schema.Number, window: Schema.Number })),
  /**
   * Always `null`: plan limits are kept per provider account (`AccountLimits`). Still sent
   * so clients built when they were per session keep decoding sessions.
   */
  limits: Schema.NullOr(UsageLimits),
  status: SessionStatus,
  /** Provider-native id used to resume the conversation (Claude session id / Codex thread id). */
  resumeId: Schema.NullOr(Schema.String),
  /** Last assistant message, kept for list views and orchestration tools. */
  lastMessage: Schema.NullOr(Schema.String),
  completedTurns: Schema.Number,
  /** Everything this session has used since Apollo started tracking it. */
  usage: Usage,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Session = typeof Session.Type;

// ---------------------------------------------------------------------------
// Normalized agent events (provider-agnostic)
// ---------------------------------------------------------------------------

/** `peer`: another of the user's bots, answering a mention (`fromBotId`). */
export const MessageAuthor = Schema.Literals(["user", "bot", "system", "peer"]);
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
  /** A `string` field for long text (shown as a text area). */
  multiline: Schema.optional(Schema.Boolean),
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

/** A file uploaded for a message (POST /api/attachments/<sessionId>). */
export const AttachmentRef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mime: Schema.String,
  size: Schema.Number,
});
export type AttachmentRef = typeof AttachmentRef.Type;

/** How the UI shows an artifact; `file` is anything it can only offer as a download. */
export const ArtifactKind = Schema.Literals(["html", "markdown", "code", "text", "image", "file"]);
export type ArtifactKind = typeof ArtifactKind.Type;

/**
 * One version of a file a bot saved with `apollo_artifact_save`, stored on disk under
 * `<dataDir>/artifacts/<botId>/<artifactId>/` and served at
 * `/api/artifacts/<botId>/<artifactId>/<version>`. Versions never change once saved.
 */
export const ArtifactRef = Schema.Struct({
  artifactId: Schema.String,
  botId: BotId,
  version: Schema.Number,
  /** File name, with its extension. */
  name: Schema.String,
  title: Schema.String,
  kind: ArtifactKind,
  mime: Schema.String,
  size: Schema.Number,
  /** Language for `code` artifacts (from the extension), e.g. "ts". */
  language: Schema.optional(Schema.String),
});
export type ArtifactRef = typeof ArtifactRef.Type;

export const AgentEvent = Schema.Union([
  Schema.TaggedStruct("UserMessage", {
    text: Schema.String,
    /** Who sent it: the human, the orchestrating bot, or Apollo itself. */
    author: MessageAuthor,
    attachments: Schema.optional(Schema.Array(AttachmentRef)),
    /** For `peer` messages: the bot that wrote it. */
    fromBotId: Schema.optional(BotId),
  }),
  Schema.TaggedStruct("TurnStarted", {}),
  /**
   * Files the turn changed in git repositories (Apollo detects these, not the agent). With
   * `report`: the full semantic diff of one repository against its baseline, which the user
   * asked for (`repos` then holds that repository only).
   */
  Schema.TaggedStruct("FilesChanged", { repos: Schema.Array(RepoChanges), report: Schema.optional(ChangeReport) }),
  /** A browser recording an agent made; its frames are served at /api/recordings/<id>/<frame>.jpg. */
  Schema.TaggedStruct("Recording", {
    recordingId: Schema.String,
    title: Schema.String,
    frames: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
    durationMs: Schema.Number,
  }),
  /** `/clear`: a fresh conversation starts; the chat shows nothing before this point. */
  Schema.TaggedStruct("ConversationCleared", {}),
  /** The user excluded (or restored) the message at `seq` from the bot's memory. */
  Schema.TaggedStruct("MemoryExclusion", { seq: Schema.Number, excluded: Schema.Boolean }),
  /** Live only (not stored): streamed text, then the final AssistantMessage with the same itemId. */
  Schema.TaggedStruct("AssistantDelta", { itemId: Schema.String, text: Schema.String }),
  /** Live only: streamed thinking, then the final Reasoning with the same itemId. */
  Schema.TaggedStruct("ReasoningDelta", { itemId: Schema.String, text: Schema.String }),
  /** Live only: the agent is compacting its context (true), or done (false). */
  Schema.TaggedStruct("Compacting", { active: Schema.Boolean }),
  /** Live only: the model started writing a tool call; ToolStarted follows with its input. */
  Schema.TaggedStruct("ToolPending", { itemId: Schema.String, name: Schema.String }),
  Schema.TaggedStruct("AssistantMessage", { itemId: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("Reasoning", { itemId: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("ToolStarted", {
    itemId: Schema.String,
    name: Schema.String,
    /** Short human-readable summary of the call (command, file path, ...). */
    summary: Schema.String,
    /** Set when a subagent made this call: the itemId of the tool call that started the subagent. */
    parentItemId: Schema.optional(Schema.String),
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
  /** A self-contained HTML page an agent shows in the conversation (`apollo_show_html`). */
  Schema.TaggedStruct("Visual", {
    visualId: Schema.String,
    title: Schema.String,
    html: Schema.String,
    /** Preferred height in CSS pixels; the page can grow to its content. */
    height: Schema.NullOr(Schema.Number),
    /**
     * Set when the visual shows an artifact (`apollo_artifact_save`/`_show`). Clients that know
     * it show the stored file; older ones ignore it and render `html`, a fallback rendering of it.
     */
    artifact: Schema.optional(ArtifactRef),
  }),
  /** An agent asked the user for a secret (`apollo_request_secret`). The value never enters the log. */
  Schema.TaggedStruct("SecretRequested", {
    requestId: Schema.String,
    label: Schema.String,
    reason: Schema.String,
    placeholder: Schema.NullOr(Schema.String),
  }),
  /**
   * An agent handed the browser to the user (`apollo_browser_handoff`): a CAPTCHA, a 2FA code,
   * a sign-in to finish. The agent waits until the user says they are done.
   */
  Schema.TaggedStruct("BrowserHandoff", {
    requestId: Schema.String,
    tabId: Schema.String,
    url: Schema.String,
    reason: Schema.String,
  }),
  Schema.TaggedStruct("BrowserHandoffResolved", {
    requestId: Schema.String,
    outcome: Schema.Literals(["done", "cancelled", "expired"]),
  }),
  Schema.TaggedStruct("SecretResolved", {
    requestId: Schema.String,
    outcome: Schema.Literals(["provided", "declined", "expired"]),
    /** Where a provided secret came from. */
    source: Schema.NullOr(Schema.Literals(["typed", "1password"])),
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
  /** Belongs to one of the bot's projects: only that project's sessions find it by search. */
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
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
  /** The tailnet device this client is bound to (it may only connect from there), if any. */
  nodeName: Schema.NullOr(Schema.String),
  /** Every request must be signed by a key that never leaves the device (Secure Enclave). */
  deviceKey: Schema.Boolean,
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
  /**
   * The device's public key (base64url of an uncompressed P-256 point). When present, the
   * request must carry an `x-apollo-proof` signed by it, and so must every later request.
   */
  deviceKey: Schema.optional(Schema.String),
});
export type PairRequest = typeof PairRequest.Type;

export const PairResponse = Schema.Struct({
  clientId: ClientId,
  sessionToken: Schema.NullOr(Schema.String),
});
export type PairResponse = typeof PairResponse.Type;

/**
 * A device on the user's tailnet asking to pair. It gets in only once someone at the
 * computer allows it (`GET /api/auth/pairing/pending`, `POST /api/auth/pairing/decide`).
 */
export const PendingPairing = Schema.Struct({
  id: Schema.String,
  /** The name the device gave itself. */
  label: Schema.String,
  /** Verified by Tailscale: the device's tailnet name, OS and signed-in account. */
  nodeName: Schema.String,
  os: Schema.String,
  loginName: Schema.String,
  deviceKey: Schema.Boolean,
  expiresAt: Timestamp,
});
export type PendingPairing = typeof PendingPairing.Type;

export const PairingDecision = Schema.Struct({ id: Schema.String, approve: Schema.Boolean });
export type PairingDecision = typeof PairingDecision.Type;

/** Message a device key signs for `x-apollo-proof: <timestamp ms>.<nonce>.<base64url DER signature>`. */
export const deviceProofMessage = (method: string, path: string, timestamp: string, nonce: string) =>
  `apollo-proof-v1\n${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}`;

// ---------------------------------------------------------------------------
// Provider settings
// ---------------------------------------------------------------------------

/** How Claude Code signs in: the user's own `claude` login (subscription), or an API key saved in Apollo. */
/** Providers whose CLI can run on more than one account. */
export const AccountProvider = Schema.Literals(["claude", "codex"]);
export type AccountProvider = typeof AccountProvider.Type;

/**
 * Another subscription Apollo can run bots on (e.g. personal next to work): its own Claude
 * Code or Codex login, with that account's connectors or apps. Settings and skills are shared.
 */
export const ProviderAccount = Schema.Struct({
  id: Schema.String,
  provider: AccountProvider,
  name: Schema.String,
  loggedIn: Schema.Boolean,
  email: Schema.NullOr(Schema.String),
  orgName: Schema.NullOr(Schema.String),
  /** e.g. `pro`, `max`, `team`, `plus`. */
  plan: Schema.NullOr(Schema.String),
  /** A sign-in is in progress: the page it opened, and why it stopped if it failed. */
  signIn: Schema.NullOr(Schema.Struct({ url: Schema.NullOr(Schema.String), error: Schema.NullOr(Schema.String) })),
});
export type ProviderAccount = typeof ProviderAccount.Type;

export const ClaudeAuth = Schema.Literals(["subscription", "api-key"]);
export type ClaudeAuth = typeof ClaudeAuth.Type;

/** `managed`: Apollo installs and runs llama-server. `external`: one the user runs. */
export const LlamaCppMode = Schema.Literals(["managed", "external"]);
export type LlamaCppMode = typeof LlamaCppMode.Type;

/**
 * Smallest context cap a llama.cpp session accepts. Claude Code compacts at its window
 * minus ~33k tokens (20k reserved for the reply, 13k buffer), and its first prompt (system
 * prompt, every tool, Apollo's instructions) is already 32-41k. At 64k it would compact
 * on every turn; 96k leaves 25-30k for the conversation itself.
 */
export const LLAMACPP_MIN_CONTEXT_TOKENS = 98_304;

/** Provider settings as the UI sees them. Keys are write-only: only whether one is saved. */
export const ProviderSettings = Schema.Struct({
  claude: Schema.Struct({ auth: ClaudeAuth, apiKeySaved: Schema.Boolean }),
  llamacpp: Schema.Struct({
    mode: LlamaCppMode,
    baseUrl: Schema.String,
    apiKeySaved: Schema.Boolean,
    /** Whether local models may start Claude Code subagents (off: one model at a time is all most machines run). */
    allowSubagents: Schema.Boolean,
    /**
     * Most tokens a local model session may use (`null`: the model's whole context). Smaller
     * keeps turns fast and llama-server's KV cache small, at the cost of compacting sooner.
     */
    maxContextTokens: Schema.NullOr(Schema.Number),
  }),
});
export type ProviderSettings = typeof ProviderSettings.Type;

/** A key field: omitted keeps the saved key, `null` clears it. */
const KeyUpdate = Schema.optional(Schema.NullOr(Schema.String));

export const UpdateProviderSettingsInput = Schema.Struct({
  claude: Schema.optional(Schema.Struct({ auth: Schema.optional(ClaudeAuth), apiKey: KeyUpdate })),
  llamacpp: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(LlamaCppMode),
      baseUrl: Schema.optional(Schema.String),
      apiKey: KeyUpdate,
      allowSubagents: Schema.optional(Schema.Boolean),
      /** `null` removes the cap. At least `LLAMACPP_MIN_CONTEXT_TOKENS`. */
      maxContextTokens: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
  ),
});
export type UpdateProviderSettingsInput = typeof UpdateProviderSettingsInput.Type;
