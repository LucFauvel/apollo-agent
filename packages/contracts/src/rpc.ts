import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  ApprovalDecision,
  InputResponse,
  Bot,
  BotId,
  ClientId,
  CoreMemory,
  CoreMemoryTarget,
  Memory,
  MemoryId,
  MemoryKind,
  PairedClient,
  PairingToken,
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
]);
export type AppChange = typeof AppChange.Type;

export const AppSnapshot = Schema.Struct({
  bots: Schema.Array(Bot),
  sessions: Schema.Array(Session),
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
});
export type CreateBotInput = typeof CreateBotInput.Type;

export const UpdateBotInput = Schema.Struct({
  botId: BotId,
  name: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  defaultWorker: Schema.optional(ProviderSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  autoLearn: Schema.optional(Schema.Boolean),
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

const error = ApolloError;

export class ApolloRpcs extends RpcGroup.make(
  // --- app ---------------------------------------------------------------
  Rpc.make("app.snapshot", { success: AppSnapshot, error }),
  Rpc.make("app.changes", { success: AppChange, stream: true }),

  // --- bots --------------------------------------------------------------
  Rpc.make("bots.create", { payload: CreateBotInput, success: Bot, error }),
  Rpc.make("bots.update", { payload: UpdateBotInput, success: Bot, error }),
  Rpc.make("bots.delete", { payload: { botId: BotId }, error }),

  // --- sessions ----------------------------------------------------------
  Rpc.make("sessions.create", { payload: CreateSessionInput, success: Session, error }),
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
