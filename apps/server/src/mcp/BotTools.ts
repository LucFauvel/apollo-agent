import { ApolloError, ProviderKind } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { BotProposals } from "../bots/BotProposals.ts";
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";
import { McpCaller } from "./Caller.ts";

/** The user's other bots: who they are, and writing to them. */

const shared = {
  failure: ApolloError,
  failureMode: "return" as const,
  dependencies: [McpCaller],
};

const ListBots = Tool.make("apollo_list_bots", {
  ...shared,
  description:
    "The user's other bots: name, what they are for (the start of their instructions), and whether they are busy or paused. Write to one with apollo_ask_bot.",
  // A tool without parameters needs EmptyParams: an empty Struct is not a valid MCP input schema.
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    bots: Schema.Array(
      Schema.Struct({ name: Schema.String, about: Schema.String, status: Schema.String }),
    ),
  }),
}).annotate(Tool.Readonly, true);

const AskBot = Tool.make("apollo_ask_bot", {
  ...shared,
  description: [
    "Write to another of the user's bots (by name, see apollo_list_bots): a question, a request, or information it needs.",
    "Your message shows in its conversation as from you; its answer comes back to you later as a message, like a",
    "worker report (do not wait for it in this turn). Make the message self-contained: it does not see this",
    "conversation. Bots can exchange a few messages before the user has to take part again.",
  ].join(" "),
  parameters: Schema.Struct({ bot: Schema.String, message: Schema.String }),
  success: Schema.Struct({ sent: Schema.Boolean, to: Schema.String }),
});

const CreateBot = Tool.make("apollo_create_bot", {
  ...shared,
  description: [
    "Propose a new bot to the user (orchestrator only), when they ask for one or agree to it. They see a card where",
    "they pick its model and approve or edit its name and instructions; nothing is created until they accept, and",
    "this waits for their answer. `instructions`: who the bot is, what it is for and how it works, written to it",
    "(\"You are …\"). `provider` (default: yours) and `model` (an id from apollo_list_models) are your suggestion;",
    "the user has the last word. It gets your workers, permissions and accounts, and its own workspace.",
    "Fails if the user declines or does not answer.",
  ].join(" "),
  parameters: Schema.Struct({
    name: Schema.String,
    instructions: Schema.String,
    provider: Schema.optional(ProviderKind),
    model: Schema.optional(Schema.String),
    /** How long to wait for the user, in seconds (default 1800, at most 3600). */
    timeoutSeconds: Schema.optional(Schema.Number),
  }),
  success: Schema.Struct({
    created: Schema.Boolean,
    botId: Schema.String,
    name: Schema.String,
    provider: ProviderKind,
    model: Schema.NullOr(Schema.String),
    workspace: Schema.String,
    instructionsEdited: Schema.Boolean,
  }),
});

export const BotToolkit = Toolkit.make(ListBots, AskBot, CreateBot);

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

export const handlers = BotToolkit.toLayer(
  Effect.gen(function* () {
    const manager = yield* SessionManager;
    const store = yield* Store;
    const proposals = yield* BotProposals;
    return {
      apollo_create_bot: ({ name, instructions, provider, model, timeoutSeconds }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          if (caller.role !== "main") return yield* invalid("only the bot's orchestrator session can create bots");
          return yield* proposals.propose(caller, {
            name,
            instructions,
            provider,
            model: model?.trim() || undefined,
            timeoutMs: Math.min(Math.max(timeoutSeconds ?? 1800, 30), 3600) * 1000,
          });
        }),
      apollo_list_bots: () =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const bots = (yield* store.listBots).filter((b) => b.id !== caller.botId);
          const sessions = yield* store.listSessions();
          return {
            bots: bots.map((b) => {
              const main = sessions.find((s) => s.id === b.mainSessionId);
              const busy = main && (main.status === "running" || main.status === "starting" || main.status === "waiting-approval");
              return {
                name: b.name,
                about: b.instructions.trim().split("\n")[0]?.slice(0, 200) ?? "",
                status: b.pausedReason ? `paused: ${b.pausedReason}` : busy ? "busy" : "idle",
              };
            }),
          };
        }),
      apollo_ask_bot: ({ bot, message }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const result = yield* manager.askBot(caller.sessionId, bot, message.slice(0, 8000));
          return { sent: true, to: result.bot };
        }),
    };
  }),
);
