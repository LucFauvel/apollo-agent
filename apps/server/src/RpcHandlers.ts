import { ApolloRpcs } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import { Auth } from "./auth/Auth.ts";
import { Compaction } from "./Compaction.ts";
import { SessionManager } from "./SessionManager.ts";
import { Store } from "./Store.ts";

/** Handlers for the typed WebSocket RPC protocol used by the web/desktop UI. */
export const layer = ApolloRpcs.toLayer(
  Effect.gen(function* () {
    const manager = yield* SessionManager;
    const store = yield* Store;
    const auth = yield* Auth;
    const compaction = yield* Compaction;

    return {
      "app.snapshot": () => manager.snapshot,
      "app.changes": () => manager.changes,

      "storage.report": () => compaction.report,
      "storage.compact": () => compaction.compact,

      "bots.create": (input) => manager.createBot(input),
      "bots.update": (input) => manager.updateBot(input),
      "bots.delete": ({ botId }) => manager.deleteBot(botId),

      "sessions.create": ({ botId, title, provider, cwd, prompt }) =>
        manager.createSession({ botId, title, provider, cwd, prompt }),
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
