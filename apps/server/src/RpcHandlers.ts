import { ApolloError, type AppChange, ApolloRpcs } from "@apollo/contracts";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import { AppSettings } from "./AppSettings.ts";
import { PullRequests } from "./pullRequests/PullRequests.ts";
import { ProviderVersions } from "./ProviderVersions.ts";
import { Tailscale } from "./remote/Tailscale.ts";
import { Auth, PAIRING_TOKEN_TTL_MS, PHONE_PAIRING_TTL_MS } from "./auth/Auth.ts";
import { Browser } from "./browser/Browser.ts";
import { Accounts } from "./Accounts.ts";
import { Secrets } from "./secrets/Secrets.ts";
import { Compaction } from "./Compaction.ts";
import { LocalModels } from "./local/LocalModels.ts";
import { RECOMMENDED_REVIEWER } from "./local/Reviewer.ts";
import { ProviderSettings } from "./ProviderSettings.ts";
import { Scheduler } from "./schedule/Scheduler.ts";
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
    const scheduler = yield* Scheduler;
    const browser = yield* Browser;
    const accounts = yield* Accounts;
    const secrets = yield* Secrets;
    const appSettings = yield* AppSettings;
    const pullRequests = yield* PullRequests;
    const providerVersions = yield* ProviderVersions;
    const tailscale = yield* Tailscale;
    // Errors from the local-model service reach the UI as plain messages.
    const local = <A, R>(effect: Effect.Effect<A, Error, R>) =>
      effect.pipe(Effect.mapError((error) => new ApolloError({ code: "internal", message: error.message })));

    return {
      "app.snapshot": () =>
        Effect.all([manager.snapshot, scheduler.list(), browser.list(), pullRequests.list]).pipe(
          Effect.map(([snapshot, schedules, browserTabs, prs]) => ({ ...snapshot, schedules, browserTabs, pullRequests: prs })),
        ),
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
      "providers.versions": ({ refresh }) => providerVersions.versions(refresh ?? false),
      "providers.update": ({ provider }) => providerVersions.update(provider),
      "localModels.setDefault": ({ model }) => localModels.setDefault(model),
      "localModels.setReviewer": ({ model }) => localModels.setReviewer(model),
      // Selected right away; reviews ask the user until the download finishes.
      "localModels.installReviewer": () =>
        local(
          localModels
            .download(RECOMMENDED_REVIEWER.repo, RECOMMENDED_REVIEWER.quant)
            .pipe(Effect.andThen(localModels.setReviewer(`${RECOMMENDED_REVIEWER.repo}:${RECOMMENDED_REVIEWER.quant}`))),
        ),

      "schedules.create": (input) => scheduler.create(input, "user"),
      "schedules.update": (input) => scheduler.update(input),
      "schedules.delete": ({ scheduleId }) => scheduler.remove(scheduleId),
      "schedules.runNow": ({ scheduleId }) => scheduler.runNow(scheduleId),
      "schedules.runs": ({ scheduleId }) => scheduler.runs(scheduleId),
      "schedules.preview": ({ spec, timezone }) => scheduler.preview(spec, timezone),

      "secrets.respond": ({ sessionId, requestId, response }) => secrets.respond(sessionId, requestId, response),
      "secrets.onePasswordStatus": () => secrets.onePasswordStatus,
      "secrets.onePasswordSearch": ({ query }) => secrets.onePasswordSearch(query),
      "secrets.onePasswordFields": ({ itemId, vaultId }) => secrets.onePasswordFields(itemId, vaultId),

      "accounts.list": () => accounts.list,
      "accounts.add": ({ provider, name }) => accounts.add(provider, name),
      "accounts.rename": ({ accountId, name }) => accounts.rename(accountId, name),
      "accounts.remove": ({ accountId }) => accounts.remove(accountId),
      "accounts.signIn": ({ accountId }) => accounts.signIn(accountId),
      "accounts.submitCode": ({ accountId, code }) => accounts.submitCode(accountId, code),
      "browser.status": () => browser.status,
      "browser.open": ({ botId, url }) =>
        Effect.flatMap(store.getBot(botId), (bot) => browser.openForUser(bot.id, bot.mainSessionId, url)),
      "browser.navigate": ({ tabId, url }) => browser.navigateForUser(tabId, url).pipe(Effect.asVoid),
      "browser.close": ({ tabId }) => browser.closeForUser(tabId),
      "browser.input": ({ tabId, input }) => browser.input(tabId, input),
      "browser.watch": ({ tabId }) => browser.watch(tabId),
      "browser.handoffRespond": ({ sessionId, requestId, outcome, note }) => browser.respondHandoff(sessionId, requestId, outcome, note ?? null),

      "storage.report": () => compaction.report,
      "storage.compact": () => compaction.compact,

      "providers.models": ({ provider }) => manager.listModels(provider),
      "app.settings": () => appSettings.read,
      "app.updateSettings": (input) =>
        Effect.gen(function* () {
          const settings = yield* appSettings.update(input);
          // Review turned off: what was waiting becomes active.
          if (input.reviewSkills === false) {
            for (const botId of yield* store.activateProposedSkills) yield* manager.publishSkillChanged(botId);
          }
          return settings;
        }),
      "app.projects": () => appSettings.projects,
      "providers.settings": () => providerSettings.view,
      "providers.updateSettings": (input) =>
        providerSettings.update(input).pipe(Effect.tap(() => manager.refreshModels)),

      "bots.create": (input) => manager.createBot(input),
      "bots.update": (input) => manager.updateBot(input),
      "bots.delete": ({ botId }) => manager.deleteBot(botId),
      "bots.stop": ({ botId }) => manager.stopBot(botId),
      "bots.resume": ({ botId }) => manager.resumeBot(botId),

      "sessions.create": ({ botId, title, provider, cwd, isolation, prompt }) =>
        manager.createSession({ botId, title, provider, cwd, isolation, prompt }),
      "sessions.update": (input) => manager.updateSessionSettings(input),
      "sessions.send": ({ sessionId, text, attachments }) => manager.send(sessionId, text, "user", attachments ?? []),
      "sessions.interrupt": ({ sessionId }) => manager.interrupt(sessionId),
      "sessions.commands": ({ sessionId }) => manager.listCommands(sessionId),
      "sessions.runCommand": ({ sessionId, name, args }) => manager.runCommand(sessionId, name, args),
      "pullRequests.unlink": ({ sessionId, url }) => pullRequests.unlink(sessionId, url),
      "sessions.setMemoryExclusion": ({ sessionId, seq, excluded }) =>
        manager.setMemoryExclusion(sessionId, seq, excluded),
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
      "changes.list": ({ sessionId }) => manager.changesList(sessionId),
      "changes.file": ({ sessionId, repo, path, reportSeq }) => manager.changesFile(sessionId, repo, path, reportSeq),
      "remote.status": () => tailscale.read,
      "remote.setTailscale": ({ enabled }) => tailscale.setEnabled(enabled),
      "remote.signOutTailscale": () => tailscale.signOut,
      "auth.revokeClient": ({ clientId }) => Effect.sync(() => auth.revokeClient(clientId)),
      "auth.createPairingToken": ({ label, phone }) =>
        Effect.sync(() => auth.createPairingToken(label, Date.now(), phone ? PHONE_PAIRING_TTL_MS : PAIRING_TOKEN_TTL_MS)),
    };
  }),
);
