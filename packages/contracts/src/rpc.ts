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
import { LlamaBackend, LocalModelsState, ModelCandidate, ModelDetails, SuggestedModel } from "./local.ts";
import {
  ApprovalDecision,
  InputResponse,
  Bot,
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
});
export type AppSnapshot = typeof AppSnapshot.Type;

export const CreateBotInput = Schema.Struct({
  name: Schema.String,
  instructions: Schema.String,
  cwd: Schema.String,
  main: ProviderSelection,
  defaultWorker: ProviderSelection,
  runtimeMode: RuntimeMode,
  autoLearn: Schema.Boolean,
  limits: Schema.optional(BotLimits),
});
export type CreateBotInput = typeof CreateBotInput.Type;

export const UpdateBotInput = Schema.Struct({
  botId: BotId,
  name: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  /** Model and effort of the orchestrator; its provider cannot change. */
  main: Schema.optional(ProviderSelection),
  defaultWorker: Schema.optional(ProviderSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  autoLearn: Schema.optional(Schema.Boolean),
  limits: Schema.optional(BotLimits),
});
export type UpdateBotInput = typeof UpdateBotInput.Type;

export const CreateSessionInput = Schema.Struct({
  botId: BotId,
  title: Schema.String,
  provider: ProviderSelection,
  cwd: Schema.optional(Schema.String),
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
  /** Applies to provider processes started afterwards. */
  Rpc.make("providers.updateSettings", { payload: UpdateProviderSettingsInput, success: ProviderSettings, error }),

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
  Rpc.make("sessions.send", { payload: { sessionId: SessionId, text: Schema.String }, error }),
  Rpc.make("sessions.interrupt", { payload: { sessionId: SessionId }, error }),
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
  Rpc.make("sessions.reflect", { payload: { sessionId: SessionId }, success: Session, error }),
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
  Rpc.make("auth.listClients", { success: Schema.Array(PairedClient), error }),
  Rpc.make("auth.revokeClient", { payload: { clientId: ClientId }, error }),
  Rpc.make("auth.createPairingToken", {
    payload: { label: Schema.String },
    success: PairingToken,
    error,
  }),
) {}
