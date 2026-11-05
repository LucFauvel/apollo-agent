import { ApolloError, type AppChange, ApolloRpcs } from "@apollo/contracts";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import { Auth } from "./auth/Auth.ts";
import { Compaction } from "./Compaction.ts";
import { LocalModels } from "./local/LocalModels.ts";
import { ProviderSettings } from "./ProviderSettings.ts";
import { SessionManager } from "./SessionManager.ts";
import { Store } from "./Store.ts";

/** Handlers for the typed WebSocket RPC protocol used by the web/desktop UI. */
export const layer = ApolloRpcs.toLayer(
  Effect.gen(function* () {
    const manager = yield* SessionManager;
    const store = yield* Store;
    const auth = yield* Auth;
    const compaction = yield* Compaction;
    const providerSettings = yield* ProviderSettings;
    const localModels = yield* LocalModels;
    // Errors from the local-model service reach the UI as plain messages.
    const local = <A, R>(effect: Effect.Effect<A, Error, R>) =>
      effect.pipe(Effect.mapError((error) => new ApolloError({ code: "internal", message: error.message })));

    return {
      "app.snapshot": () => manager.snapshot,
      "app.changes": () =>
        Stream.merge(
          manager.changes,
          localModels.changes.pipe(Stream.map((state): AppChange => ({ _tag: "LocalModelsChanged", state }))),
        ),

      "localModels.state": () => localModels.state,
      "localModels.installEngine": ({ backend }) => local(localModels.installEngine(backend)),
      "localModels.checkForUpdate": () => localModels.checkForUpdate,
      "localModels.startServer": () => local(localModels.startServer),
      "localModels.stopServer": () => localModels.stopServer,
      "localModels.logs": () => localModels.logs,
      "localModels.suggested": () => local(localModels.suggested),
      "localModels.search": ({ query }) => local(localModels.search(query)),
      "localModels.details": ({ repo }) => local(localModels.details(repo)),
      "localModels.download": ({ repo, quant }) => local(localModels.download(repo, quant)),
      "localModels.cancelDownload": ({ model }) => local(localModels.cancelDownload(model)),
      "localModels.delete": ({ model }) => local(localModels.deleteModel(model)),
      "localModels.setDefault": ({ model }) => localModels.setDefault(model),

      "storage.report": () => compaction.report,
      "storage.compact": () => compaction.compact,

      "providers.models": ({ provider }) => manager.listModels(provider),
      "providers.settings": () => providerSettings.view,
      "providers.updateSettings": (input) =>
        providerSettings.update(input).pipe(Effect.tap(() => manager.refreshModels)),

      "bots.create": (input) => manager.createBot(input),
      "bots.update": (input) => manager.updateBot(input),
      "bots.delete": ({ botId }) => manager.deleteBot(botId),
      "bots.stop": ({ botId }) => manager.stopBot(botId),
      "bots.resume": ({ botId }) => manager.resumeBot(botId),

      "sessions.create": ({ botId, title, provider, cwd, prompt }) =>
        manager.createSession({ botId, title, provider, cwd, prompt }),
      "sessions.update": (input) => manager.updateSessionSettings(input),
      "sessions.send": ({ sessionId, text }) => manager.send(sessionId, text, "user"),
      "sessions.interrupt": ({ sessionId }) => manager.interrupt(sessionId),
      "sessions.close": ({ sessionId }) => manager.closeSession(sessionId),
      "sessions.delete": ({ sessionId }) => manager.deleteSession(sessionId),
      "sessions.respondApproval": ({ sessionId, requestId, decision }) =>
        manager.respondApproval(sessionId, requestId, decision),
      "sessions.respondInput": ({ sessionId, requestId, response }) =>
        manager.respondInput(sessionId, requestId, response),
      "sessions.reflect": ({ sessionId }) => manager.reflect(sessionId),
      "sessions.events": ({ sessionId, afterSeq }) => manager.events(sessionId, afterSeq),

      "memory.list": ({ botId }) => store.listMemories(botId),
      "memory.create": ({ botId, kind, content, tags }) =>
        store
          .insertMemory({ botId, kind, content, tags, sourceSessionId: null })
          .pipe(Effect.tap(() => manager.publishMemoryChanged(botId))),
      "memory.core": ({ botId }) => store.getCoreMemory(botId),
      "memory.setCore": ({ botId, target, entries }) =>
        Effect.gen(function* () {
          yield* store.setCoreMemory(botId, target, entries);
          yield* manager.publishMemoryChanged(target === "user" ? null : botId);
          return yield* store.getCoreMemory(botId);
        }),
      "memory.delete": ({ memoryId }) =>
        Effect.gen(function* () {
          const memory = yield* store.getMemory(memoryId);
          yield* store.deleteMemory(memoryId);
          yield* manager.publishMemoryChanged(memory.botId);
        }),

      "skills.list": ({ botId }) => store.listSkills(botId),
      "skills.setStatus": ({ skillId, status }) =>
        Effect.gen(function* () {
          const skill = yield* store.getSkill(skillId);
          yield* store.setSkillStatus(skillId, status);
          yield* manager.publishSkillChanged(skill.botId);
        }),
      "skills.delete": ({ skillId }) =>
        Effect.gen(function* () {
          const skill = yield* store.getSkill(skillId);
          yield* store.deleteSkill(skillId);
          yield* manager.publishSkillChanged(skill.botId);
        }),

      "auth.listClients": () => Effect.sync(() => auth.listClients()),
      "auth.revokeClient": ({ clientId }) => Effect.sync(() => auth.revokeClient(clientId)),
      "auth.createPairingToken": ({ label }) => Effect.sync(() => auth.createPairingToken(label)),
    };
  }),
);
