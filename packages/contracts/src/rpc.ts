import { AppSettings, ProjectInfo, UpdateAppSettingsInput } from "./appSettings.ts";
import { PullRequest } from "./pullRequests.ts";
import { ChangesOverview, SemanticFileDiff } from "./changes.ts";
import { RemoteAccess } from "./remote.ts";
import { ProviderVersion } from "./connectors.ts";
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  CreateScheduleInput,
  Schedule,
  ScheduleId,
  SchedulePreview,
  ScheduleRun,
  UpdateScheduleInput,
} from "./schedule.ts";
import { OnePasswordField, OnePasswordItem, OnePasswordStatus, SecretResponse } from "./secrets.ts";
import { BrowserFrame, BrowserInput, BrowserStatus, BrowserTab } from "./browser.ts";
import { LlamaBackend, LocalModelsState, ModelCandidate, ModelDetails, SuggestedModel } from "./local.ts";
import {
  ApprovalDecision,
  InputResponse,
  Bot,
  AccountProvider,
  ProviderAccount,
  BotId,
  BotLimits,
  Usage,
  ClientId,
  CoreMemory,
  CoreMemoryTarget,
  Memory,
  MemoryId,
  MemoryKind,
  PairedClient,
  PairingToken,
  ModelOption,
  ProviderKind,
  ProviderSettings,
  UpdateProviderSettingsInput,
  ProviderSelection,
  RuntimeMode,
  Session,
  SessionEvent,
  SessionId,
  Skill,
  SkillId,
  StorageReport,
  SkillStatus,
  BotAvatar,
  AttachmentRef,
} from "./domain.ts";

export class ApolloError extends Schema.TaggedError<ApolloError>()("ApolloError", {
  code: Schema.Literals(["not_found", "invalid", "provider", "internal"]),
  message: Schema.String,
}) {}

/** Pushed to every connected client whenever server-side state changes. */
export const AppChange = Schema.Union([
  Schema.TaggedStruct("BotUpserted", { bot: Bot }),
  Schema.TaggedStruct("BotDeleted", { botId: BotId }),
  Schema.TaggedStruct("SessionUpserted", { session: Session }),
  Schema.TaggedStruct("SessionDeleted", { sessionId: SessionId }),
  Schema.TaggedStruct("MemoryChanged", { botId: Schema.NullOr(BotId) }),
  Schema.TaggedStruct("SkillChanged", { botId: Schema.NullOr(BotId) }),
  Schema.TaggedStruct("BotUsageToday", { botId: BotId, usage: Usage }),
  Schema.TaggedStruct("LocalModelsChanged", { state: LocalModelsState }),
  Schema.TaggedStruct("ScheduleUpserted", { schedule: Schedule }),
  Schema.TaggedStruct("ScheduleDeleted", { scheduleId: ScheduleId, botId: BotId }),
  Schema.TaggedStruct("BrowserTabUpserted", { tab: BrowserTab }),
  Schema.TaggedStruct("BrowserTabClosed", { tabId: Schema.String, botId: BotId }),
  Schema.TaggedStruct("PullRequestUpserted", { pullRequest: PullRequest }),
  Schema.TaggedStruct("PullRequestRemoved", { url: Schema.String, sessionId: SessionId }),
  /** A session's changes or their explanations changed: refetch `changes.list`. */
  Schema.TaggedStruct("ChangesUpdated", { sessionId: SessionId, botId: BotId }),
  /** Something the user should see now: clients show it as a desktop notification. */
  Schema.TaggedStruct("Notify", {
    botId: BotId,
    /** The session to open when the notification is clicked. */
    sessionId: Schema.NullOr(SessionId),
    title: Schema.String,
    body: Schema.String,
  }),
]);
export type AppChange = typeof AppChange.Type;

export const AppSnapshot = Schema.Struct({
  bots: Schema.Array(Bot),
  sessions: Schema.Array(Session),
  /** Each bot's usage today (server local time). */
  usageToday: Schema.Array(Schema.Struct({ botId: BotId, usage: Usage })),
  schedules: Schema.Array(Schedule),
  browserTabs: Schema.Array(BrowserTab),
  pullRequests: Schema.Array(PullRequest),
});
export type AppSnapshot = typeof AppSnapshot.Type;

/** A command typed as `/name args` in the message box. */
export const SlashCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  argumentHint: Schema.String,
  /** `apollo`: handled by Apollo; `provider`: sent to the agent's harness as a message. */
  source: Schema.Literals(["apollo", "provider"]),
});
export type SlashCommand = typeof SlashCommand.Type;

export const CreateBotInput = Schema.Struct({
  name: Schema.String,
  /** Omitted: a random one. */
  avatar: Schema.optional(BotAvatar),
  instructions: Schema.String,
  cwd: Schema.String,
  main: ProviderSelection,
  defaultWorker: ProviderSelection,
  runtimeMode: RuntimeMode,
  autoLearn: Schema.Boolean,
  limits: Schema.optional(BotLimits),
  claudeAccountId: Schema.optional(Schema.NullOr(Schema.String)),
  codexAccountId: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CreateBotInput = typeof CreateBotInput.Type;

export const UpdateBotInput = Schema.Struct({
  botId: BotId,
  name: Schema.optional(Schema.String),
  avatar: Schema.optional(BotAvatar),
  instructions: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  /** Model and effort of the orchestrator; its provider cannot change. */
  main: Schema.optional(ProviderSelection),
  defaultWorker: Schema.optional(ProviderSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  autoLearn: Schema.optional(Schema.Boolean),
  limits: Schema.optional(BotLimits),
  claudeAccountId: Schema.optional(Schema.NullOr(Schema.String)),
  codexAccountId: Schema.optional(Schema.NullOr(Schema.String)),
});
export type UpdateBotInput = typeof UpdateBotInput.Type;

export const CreateSessionInput = Schema.Struct({
  botId: BotId,
  title: Schema.String,
  provider: ProviderSelection,
  cwd: Schema.optional(Schema.String),
  /** `worktree`: work in its own git worktree and branch (the workspace must be a git repo). */
  isolation: Schema.optional(Schema.Literals(["shared", "worktree"])),
  /** Optional first message, sent as soon as the session exists. */
  prompt: Schema.optional(Schema.String),
});
export type CreateSessionInput = typeof CreateSessionInput.Type;

/** Session settings; omitted fields stay as they are. Changes apply from the next turn. */
export const UpdateSessionInput = Schema.Struct({
  sessionId: SessionId,
  title: Schema.optional(Schema.String),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  effort: Schema.optional(Schema.NullOr(Schema.String)),
  runtimeMode: Schema.optional(Schema.NullOr(RuntimeMode)),
});
export type UpdateSessionInput = typeof UpdateSessionInput.Type;

const error = ApolloError;

export class ApolloRpcs extends RpcGroup.make(
  // --- app ---------------------------------------------------------------
  Rpc.make("app.snapshot", { success: AppSnapshot, error }),
  Rpc.make("app.changes", { success: AppChange, stream: true }),

  // --- providers ---------------------------------------------------------
  Rpc.make("providers.models", {
    payload: { provider: ProviderKind },
    success: Schema.Array(ModelOption),
    error,
  }),
  Rpc.make("providers.settings", { success: ProviderSettings, error }),
  /** Installed and latest versions of Claude Code, Codex and llama.cpp (checked every few hours). */
  Rpc.make("providers.versions", { payload: { refresh: Schema.optional(Schema.Boolean) }, success: Schema.Array(ProviderVersion), error }),
  /** Updates a provider's tool (`claude update`, `codex update`, or a new llama.cpp build). */
  Rpc.make("providers.update", { payload: { provider: ProviderKind }, success: ProviderVersion, error }),
  /** Applies to provider processes started afterwards. */
  /** Other Claude and Codex subscriptions bots can run on (personal vs work), each with its own login. */
  Rpc.make("accounts.list", { success: Schema.Array(ProviderAccount), error }),
  Rpc.make("accounts.add", { payload: { provider: AccountProvider, name: Schema.String }, success: ProviderAccount, error }),
  Rpc.make("accounts.rename", { payload: { accountId: Schema.String, name: Schema.String }, success: ProviderAccount, error }),
  /** Signs out, deletes its folder, and moves its bots back to this machine's login. */
  Rpc.make("accounts.remove", { payload: { accountId: Schema.String }, error }),
  /** Starts the CLI's browser sign-in for it; the account's `signIn` shows progress. */
  Rpc.make("accounts.signIn", { payload: { accountId: Schema.String }, success: ProviderAccount, error }),
  /** The code Claude's sign-in page shows, when the browser could not hand it back by itself. */
  Rpc.make("accounts.submitCode", { payload: { accountId: Schema.String, code: Schema.String }, error }),
  Rpc.make("providers.updateSettings", { payload: UpdateProviderSettingsInput, success: ProviderSettings, error }),

  // --- app settings --------------------------------------------------------
  Rpc.make("app.settings", { success: AppSettings, error }),
  Rpc.make("app.updateSettings", { payload: UpdateAppSettingsInput, success: AppSettings, error }),
  /** Projects found in the project folders (git repos and folders with a project manifest). */
  Rpc.make("app.projects", { success: Schema.Array(ProjectInfo), error }),

  // --- local models (llama.cpp managed by Apollo) -------------------------
  Rpc.make("localModels.state", { success: LocalModelsState, error }),
  /** Downloads and verifies a llama.cpp build; progress arrives as `LocalModelsChanged`. */
  Rpc.make("localModels.installEngine", { payload: { backend: LlamaBackend }, error }),
  Rpc.make("localModels.checkForUpdate", { success: LocalModelsState, error }),
  Rpc.make("localModels.startServer", { error }),
  Rpc.make("localModels.stopServer", { error }),
  /** The last lines llama-server printed. */
  Rpc.make("localModels.logs", { success: Schema.Array(Schema.String), error }),
  /** Popular models from trusted GGUF publishers, sized for this machine. */
  Rpc.make("localModels.suggested", { success: Schema.Array(SuggestedModel), error }),
  Rpc.make("localModels.search", { payload: { query: Schema.String }, success: Schema.Array(ModelCandidate), error }),
  Rpc.make("localModels.details", { payload: { repo: Schema.String }, success: ModelDetails, error }),
  Rpc.make("localModels.download", { payload: { repo: Schema.String, quant: Schema.String }, error }),
  Rpc.make("localModels.cancelDownload", { payload: { model: Schema.String }, error }),
  Rpc.make("localModels.delete", { payload: { model: Schema.String }, error }),
  Rpc.make("localModels.setDefault", { payload: { model: Schema.NullOr(Schema.String) }, error }),
  /** The reviewer for auto mode on local models; `null` uses rules only. */
  Rpc.make("localModels.setReviewer", { payload: { model: Schema.NullOr(Schema.String) }, error }),
  /** Downloads the recommended reviewer model and selects it once it is ready. */
  Rpc.make("localModels.installReviewer", { error }),

  // --- bots --------------------------------------------------------------
  Rpc.make("bots.create", { payload: CreateBotInput, success: Bot, error }),
  Rpc.make("bots.update", { payload: UpdateBotInput, success: Bot, error }),
  Rpc.make("bots.delete", { payload: { botId: BotId }, error }),
  /** Interrupts everything the bot is doing and pauses its automated work. */
  Rpc.make("bots.stop", { payload: { botId: BotId }, success: Bot, error }),
  /** Lifts a pause. Fails while the bot is over today's budget. */
  Rpc.make("bots.resume", { payload: { botId: BotId }, success: Bot, error }),

  // --- sessions ----------------------------------------------------------
  Rpc.make("sessions.create", { payload: CreateSessionInput, success: Session, error }),
  Rpc.make("sessions.update", { payload: UpdateSessionInput, success: Session, error }),
  Rpc.make("sessions.send", {
    payload: { sessionId: SessionId, text: Schema.String, attachments: Schema.optional(Schema.Array(AttachmentRef)) },
    error,
  }),
  Rpc.make("sessions.interrupt", { payload: { sessionId: SessionId }, error }),
  /** Slash commands for the message box: Apollo's own, then the provider's (Claude Code custom commands, skills). */
  Rpc.make("sessions.commands", { payload: { sessionId: SessionId }, success: Schema.Array(SlashCommand), error }),
  Rpc.make("sessions.runCommand", {
    payload: { sessionId: SessionId, name: Schema.String, args: Schema.String },
    error,
  }),
  /** Stops watching (or forgets) a pull request linked to a session. */
  Rpc.make("pullRequests.unlink", { payload: { sessionId: SessionId, url: Schema.String }, error }),
  /**
   * Keeps a message out of the bot's memory: session search, apollo_session_read and the
   * reflection pass skip it. The live conversation with the agent is not changed.
   */
  Rpc.make("sessions.setMemoryExclusion", {
    payload: { sessionId: SessionId, seq: Schema.Number, excluded: Schema.Boolean },
    error,
  }),
  Rpc.make("sessions.close", { payload: { sessionId: SessionId }, error }),
  Rpc.make("sessions.delete", { payload: { sessionId: SessionId }, error }),
  Rpc.make("sessions.respondApproval", {
    payload: { sessionId: SessionId, requestId: Schema.String, decision: ApprovalDecision },
    error,
  }),
  Rpc.make("sessions.respondInput", {
    payload: { sessionId: SessionId, requestId: Schema.String, response: InputResponse },
    error,
  }),
  /** The reflection started, or null when it waits for the one already running. */
  Rpc.make("sessions.reflect", { payload: { sessionId: SessionId }, success: Schema.NullOr(Session), error }),
  /** Replays persisted events after `afterSeq`, then follows live events. */
  Rpc.make("sessions.events", {
    payload: { sessionId: SessionId, afterSeq: Schema.Number },
    success: SessionEvent,
    error,
    stream: true,
  }),

  // --- schedules (bots acting on their own) -------------------------------
  Rpc.make("schedules.create", { payload: CreateScheduleInput, success: Schedule, error }),
  Rpc.make("schedules.update", { payload: UpdateScheduleInput, success: Schedule, error }),
  Rpc.make("schedules.delete", { payload: { scheduleId: ScheduleId }, error }),
  /** Starts a run now, outside the schedule. Fails while one is running. */
  Rpc.make("schedules.runNow", { payload: { scheduleId: ScheduleId }, error }),
  /** Recent runs, newest first. */
  Rpc.make("schedules.runs", { payload: { scheduleId: ScheduleId }, success: Schema.Array(ScheduleRun), error }),
  Rpc.make("schedules.preview", {
    payload: { spec: Schema.String, timezone: Schema.optional(Schema.String) },
    success: SchedulePreview,
    error,
  }),

  // --- storage -----------------------------------------------------------
  Rpc.make("storage.report", { success: StorageReport, error }),
  Rpc.make("storage.compact", { success: StorageReport, error }),

  // --- memory ------------------------------------------------------------
  Rpc.make("memory.list", {
    payload: { botId: Schema.NullOr(BotId) },
    success: Schema.Array(Memory),
    error,
  }),
  Rpc.make("memory.create", {
    payload: {
      botId: Schema.NullOr(BotId),
      kind: MemoryKind,
      content: Schema.String,
      tags: Schema.Array(Schema.String),
    },
    success: Memory,
    error,
  }),
  Rpc.make("memory.core", { payload: { botId: BotId }, success: CoreMemory, error }),
  Rpc.make("memory.setCore", {
    payload: { botId: BotId, target: CoreMemoryTarget, entries: Schema.Array(Schema.String) },
    success: CoreMemory,
    error,
  }),
  Rpc.make("memory.delete", { payload: { memoryId: MemoryId }, error }),

  // --- skills ------------------------------------------------------------
  Rpc.make("skills.list", {
    payload: { botId: Schema.NullOr(BotId) },
    success: Schema.Array(Skill),
    error,
  }),
  Rpc.make("skills.setStatus", { payload: { skillId: SkillId, status: SkillStatus }, error }),
  Rpc.make("skills.delete", { payload: { skillId: SkillId }, error }),

  // --- devices -----------------------------------------------------------
  // --- secrets -------------------------------------------------------------
  Rpc.make("secrets.respond", {
    payload: { sessionId: SessionId, requestId: Schema.String, response: SecretResponse },
    error,
  }),
  Rpc.make("secrets.onePasswordStatus", { success: OnePasswordStatus, error }),
  Rpc.make("secrets.onePasswordSearch", {
    payload: { query: Schema.String },
    success: Schema.Array(OnePasswordItem),
    error,
  }),
  Rpc.make("secrets.onePasswordFields", {
    payload: { itemId: Schema.String, vaultId: Schema.String },
    success: Schema.Array(OnePasswordField),
    error,
  }),

  // --- built-in browser ----------------------------------------------------
  Rpc.make("browser.status", { success: BrowserStatus, error }),
  /** Opens a page for a bot, owned by its orchestrator. */
  Rpc.make("browser.open", { payload: { botId: BotId, url: Schema.String }, success: BrowserTab, error }),
  Rpc.make("browser.navigate", { payload: { tabId: Schema.String, url: Schema.String }, error }),
  Rpc.make("browser.close", { payload: { tabId: Schema.String }, error }),
  Rpc.make("browser.input", { payload: { tabId: Schema.String, input: BrowserInput }, error }),
  /** The user finished (or gave up on) what an agent handed them in the browser. */
  Rpc.make("browser.handoffRespond", {
    payload: {
      sessionId: SessionId,
      requestId: Schema.String,
      outcome: Schema.Literals(["done", "cancelled"]),
      /** Anything the agent should know, e.g. "signed in as work account". */
      note: Schema.optional(Schema.String),
    },
    error,
  }),
  /** Live frames of a tab while the stream is open. */
  Rpc.make("browser.watch", { payload: { tabId: Schema.String }, success: BrowserFrame, error, stream: true }),

  Rpc.make("auth.listClients", { success: Schema.Array(PairedClient), error }),
  /** Reaching Apollo from phones over Tailscale. */
  // --- changes -------------------------------------------------------------
  /** What a session changed in git repositories (an orchestrator: with its workers'). */
  Rpc.make("changes.list", { payload: { sessionId: SessionId }, success: ChangesOverview, error }),
  /** One changed file as a semantic diff, grouped by the declarations it touches. */
  Rpc.make("changes.file", {
    payload: { sessionId: SessionId, repo: Schema.String, path: Schema.String },
    success: SemanticFileDiff,
    error,
  }),
  Rpc.make("remote.status", { success: RemoteAccess, error }),
  Rpc.make("remote.setTailscale", { payload: { enabled: Schema.Boolean }, success: RemoteAccess, error }),
  /** Signs Apollo's Tailscale node out of the tailnet (publishing turns off). */
  Rpc.make("remote.signOutTailscale", { success: RemoteAccess, error }),
  Rpc.make("auth.revokeClient", { payload: { clientId: ClientId }, error }),
  Rpc.make("auth.createPairingToken", {
    /** `phone`: a QR code for the phone app, valid for two minutes instead of ten. */
    payload: { label: Schema.String, phone: Schema.optional(Schema.Boolean) },
    success: PairingToken,
    error,
  }),
) {}
