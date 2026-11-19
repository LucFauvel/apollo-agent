import { ApolloError, TODO_LIST_LIMIT } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { formatTodos, Todos } from "../todos/Todos.ts";
import { McpCaller } from "./Caller.ts";

/** The session's to-do list: the agent keeps it, the user sees it and can change it. */

const shared = {
  failure: ApolloError,
  failureMode: "return" as const,
  dependencies: [McpCaller],
};

const ListResult = Schema.Struct({
  /** One numbered line per item: `[x]` done, `[ ]` open, with its id. */
  list: Schema.String,
  open: Schema.Number,
  done: Schema.Number,
});

const TodoList = Tool.make("apollo_todo_list", {
  ...shared,
  description:
    "Read your to-do list, with each item's id. The user sees it and may add, edit, check off, reorder or remove items; Apollo tells you when they do.",
  parameters: Tool.EmptyParams,
  success: ListResult,
}).annotate(Tool.Readonly, true);

const Ids = Schema.optional(Schema.Array(Schema.String));

const TodoUpdate = Tool.make("apollo_todo_update", {
  ...shared,
  description: [
    "Change your to-do list (shown to the user beside the conversation): use it to plan multi-step work and show",
    "progress. Check items off as you finish them, one at a time, rather than all at the end. Everything given is",
    "applied together, in this order: `edit`, `check`, `uncheck`, `remove`, `clearDone`, `order`, then `add`.",
    "`add`: new items, at the end (or at `index`, 0 first). `order`: ids in the order you want, the rest keep",
    `theirs after them. Items are referred to by id (see apollo_todo_list). At most ${TODO_LIST_LIMIT} items.`,
    "Returns the whole list.",
  ].join(" "),
  parameters: Schema.Struct({
    add: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.String, index: Schema.optional(Schema.Number) }))),
    edit: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String }))),
    check: Ids,
    uncheck: Ids,
    remove: Ids,
    clearDone: Schema.optional(Schema.Boolean).annotate({ description: "Remove every checked item." }),
    order: Ids,
  }),
  success: ListResult,
});

export const TodoToolkit = Toolkit.make(TodoList, TodoUpdate);

const result = (items: Parameters<typeof formatTodos>[0]) => ({
  list: formatTodos(items),
  open: items.filter((i) => !i.done).length,
  done: items.filter((i) => i.done).length,
});

export const handlers = TodoToolkit.toLayer(
  Effect.gen(function* () {
    const todos = yield* Todos;
    return {
      apollo_todo_list: () =>
        Effect.flatMap(McpCaller, (caller) => Effect.map(todos.list(caller.sessionId, "agent"), (list) => result(list.items))),
      apollo_todo_update: (ops) =>
        Effect.flatMap(McpCaller, (caller) => Effect.map(todos.apply(caller.sessionId, ops, "agent"), ({ list }) => result(list.items))),
    };
  }),
);
