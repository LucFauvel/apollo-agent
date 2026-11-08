import { ApolloError } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
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

export const BotToolkit = Toolkit.make(ListBots, AskBot);

export const handlers = BotToolkit.toLayer(
  Effect.gen(function* () {
    const manager = yield* SessionManager;
    const store = yield* Store;
    return {
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
