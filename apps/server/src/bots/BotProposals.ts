import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  ApolloError,
  type Bot,
  type BotId,
  type InputField,
  type InputResponse,
  type InputValue,
  type ProviderKind,
  type SessionId,
} from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AppSettings } from "../AppSettings.ts";
import { PROVIDER_NAMES } from "../Instructions.ts";
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";

/**
 * Bots a bot proposes to create (`apollo_create_bot`). The user sees the proposal as an
 * `InputRequested` card (a kind every client already renders, so installed phones show it
 * too) where they pick the model and approve or edit the name and instructions; Apollo
 * answers it here instead of a provider. Nothing is created until they accept.
 */

export interface BotProposal {
  readonly name: string;
  readonly instructions: string;
  readonly provider: ProviderKind | undefined;
  readonly model: string | undefined;
  readonly timeoutMs: number;
}

/** Request ids Apollo answers itself, so `sessions.respondInput` routes them here. */
export const PROPOSAL_PREFIX = "botreq_";

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "bot";

/** `<provider>:<model id>`; an empty model id stands for the provider's default. */
const modelValue = (provider: ProviderKind, model: string) => `${provider}:${model}`;

const parseModel = (value: string): { provider: ProviderKind; model: string | undefined } | null => {
  const at = value.indexOf(":");
  if (at <= 0) return null;
  const provider = value.slice(0, at);
  if (!(provider in PROVIDER_NAMES)) return null;
  return { provider: provider as ProviderKind, model: value.slice(at + 1) || undefined };
};

const text = (value: InputValue | undefined) => (typeof value === "string" ? value.trim() : "");

const make = Effect.gen(function* () {
  const manager = yield* SessionManager;
  const store = yield* Store;
  const appSettings = yield* AppSettings;
  const pending = new Map<string, { readonly sessionId: SessionId; readonly deferred: Deferred.Deferred<InputResponse> }>();

  /** Models the user can pick from: the proposed provider's first, then the creator's, Claude's and Codex's. */
  const modelOptions = (providers: ReadonlyArray<ProviderKind>) =>
    Effect.forEach(
      [...new Set(providers)],
      (provider) =>
        manager.listModels(provider).pipe(
          Effect.timeoutOption(Duration.seconds(15)),
          Effect.map(Option.getOrElse(() => [])),
          Effect.orElseSucceed(() => []),
          Effect.map((models) => ({ provider, models })),
        ),
      { concurrency: "unbounded" },
    );

  const workspaceFor = (name: string, bots: ReadonlyArray<Bot>) =>
    Effect.gen(function* () {
      const { workspaceRoot } = yield* appSettings.read;
      const taken = new Set(bots.map((b) => b.cwd));
      const base = join(workspaceRoot, slugify(name));
      let cwd = base;
      for (let n = 2; taken.has(cwd); n++) cwd = `${base}-${n}`;
      return cwd;
    });

  const resolved = (sessionId: SessionId, requestId: string, action: InputResponse["action"]) =>
    manager.appendEvent(sessionId, { _tag: "InputResolved", requestId, action });

  /** Shows the proposal to the user, waits for their answer, and creates the bot if they accept. */
  const propose = (caller: { sessionId: SessionId; botId: BotId }, input: BotProposal) =>
    Effect.gen(function* () {
      const name = input.name.trim().slice(0, 60);
      const instructions = input.instructions.trim();
      if (!name) return yield* invalid("`name` is required");
      if (!instructions) return yield* invalid("`instructions` is required: what the new bot is for and how it works");
      const creator = yield* store.getBot(caller.botId);
      const provider = input.provider ?? creator.main.provider;

      const lists = yield* modelOptions([provider, creator.main.provider, "claude", "codex"]);
      const options: Array<{ value: string; label: string }> = [];
      for (const { provider: kind, models } of lists) {
        if (models.length === 0) {
          if (kind === provider) options.push({ value: modelValue(kind, ""), label: `${PROVIDER_NAMES[kind]} · default model` });
          continue;
        }
        for (const m of models) options.push({ value: modelValue(kind, m.id), label: `${PROVIDER_NAMES[kind]} · ${m.label}` });
      }
      const proposed = lists[0]!.models;
      if (input.model !== undefined && proposed.length > 0 && !proposed.some((m) => m.id === input.model)) {
        return yield* invalid(`unknown ${provider} model "${input.model}": use an id from apollo_list_models, or leave it out`);
      }
      const defaultModel = input.model ?? proposed.find((m) => m.isDefault)?.id ?? proposed[0]?.id ?? "";
      const fallback = modelValue(provider, defaultModel);

      const fields: Array<InputField> = [
        {
          name: "name",
          kind: "string",
          title: "Name",
          description: "",
          required: true,
          options: [],
          default: name,
          secret: false,
        },
        {
          name: "model",
          kind: "select",
          title: "Model",
          description: "The new bot's orchestrator. Its provider cannot change later; the model can.",
          required: true,
          options,
          default: fallback,
          secret: false,
        },
        {
          name: "instructions",
          kind: "string",
          title: "Instructions",
          description: `Written by ${creator.name}; edit them as you like.`,
          required: true,
          options: [],
          default: instructions,
          secret: false,
          multiline: true,
        },
      ];

      const requestId = `${PROPOSAL_PREFIX}${randomBytes(12).toString("base64url")}`;
      const deferred = yield* Deferred.make<InputResponse>();
      pending.set(requestId, { sessionId: caller.sessionId, deferred });
      yield* manager.appendEvent(caller.sessionId, {
        _tag: "InputRequested",
        requestId,
        source: creator.name,
        message: `Create a new bot, “${name}”? Pick its model and check its instructions.`,
        url: null,
        fields,
      });

      const answer = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(Duration.millis(input.timeoutMs)),
        Effect.onInterrupt(() => resolved(caller.sessionId, requestId, "cancel").pipe(Effect.ignore)),
        Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
      );
      if (Option.isNone(answer)) {
        yield* resolved(caller.sessionId, requestId, "cancel");
        return yield* invalid(`the user did not answer within ${Math.round(input.timeoutMs / 1000)} s; no bot was created`);
      }
      if (answer.value.action !== "accept") {
        yield* resolved(caller.sessionId, requestId, answer.value.action);
        return yield* invalid(`the user declined to create "${name}"; do not propose it again unless they ask`);
      }

      const values = answer.value.values;
      const finalName = text(values.name).slice(0, 60) || name;
      const finalInstructions = text(values.instructions) || instructions;
      const picked = text(values.model);
      const choice = parseModel(options.some((o) => o.value === picked) ? picked : fallback)!;
      const bots = yield* store.listBots;
      const bot = yield* manager
        .createBot({
          name: finalName,
          instructions: finalInstructions,
          cwd: yield* workspaceFor(finalName, bots),
          main: { provider: choice.provider, ...(choice.model ? { model: choice.model } : {}) },
          defaultWorker: creator.defaultWorker,
          runtimeMode: creator.runtimeMode,
          autoLearn: creator.autoLearn,
          claudeAccountId: creator.claudeAccountId,
          codexAccountId: creator.codexAccountId,
        })
        .pipe(Effect.tapError(() => resolved(caller.sessionId, requestId, "cancel").pipe(Effect.ignore)));
      yield* resolved(caller.sessionId, requestId, "accept");
      return {
        created: true,
        botId: bot.id,
        name: bot.name,
        provider: bot.main.provider,
        model: bot.main.model ?? null,
        workspace: bot.cwd,
        instructionsEdited: finalInstructions !== instructions,
      };
    });

  /** The user's answer to a proposal card. */
  const respond = (sessionId: SessionId, requestId: string, response: InputResponse) =>
    Effect.gen(function* () {
      const request = pending.get(requestId);
      if (!request || request.sessionId !== sessionId) {
        // Apollo restarted, or it expired: close the card so it stops asking.
        yield* resolved(sessionId, requestId, "cancel").pipe(Effect.ignore);
        return yield* invalid("this proposal is no longer waiting (it expired, or Apollo restarted)");
      }
      yield* Deferred.succeed(request.deferred, response);
    });

  return { propose, respond };
});

export class BotProposals extends Context.Service<BotProposals, Effect.Success<typeof make>>()("apollo/BotProposals") {}

export const layer = Layer.effect(BotProposals, make);
