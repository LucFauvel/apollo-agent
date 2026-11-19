import * as Schema from "effect/Schema";
import { BotId, SessionId, Timestamp } from "./domain.ts";

/** Longest to-do text. */
export const TODO_TEXT_LIMIT = 500;
/** Most items one session's list holds. */
export const TODO_LIST_LIMIT = 100;

/**
 * One item of a session's to-do list. The agent keeps the list with `apollo_todo_*`; the user
 * sees it and can change it too, and the agent is told what they changed.
 */
export const TodoItem = Schema.Struct({
  id: Schema.String,
  sessionId: SessionId,
  botId: BotId,
  text: Schema.String,
  done: Schema.Boolean,
  /** Who added it. */
  addedBy: Schema.Literals(["agent", "user"]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TodoItem = typeof TodoItem.Type;

/** A session's whole list, first to last. */
export const TodoList = Schema.Struct({
  sessionId: SessionId,
  botId: BotId,
  items: Schema.Array(TodoItem),
});
export type TodoList = typeof TodoList.Type;

/**
 * `todos.watch`: every non-empty list, then each list that changed, whole. Its own stream,
 * not an AppChange, so clients built before to-do lists keep syncing (see AppChange).
 */
export const TodosChange = Schema.Union([
  Schema.TaggedStruct("TodosSnapshot", { lists: Schema.Array(TodoList) }),
  Schema.TaggedStruct("TodoListChanged", { list: TodoList }),
]);
export type TodosChange = typeof TodosChange.Type;

export const AddTodoInput = Schema.Struct({
  sessionId: SessionId,
  text: Schema.String,
  /** Where it goes (0 is first); omitted: at the end. */
  index: Schema.optional(Schema.Number),
});
export type AddTodoInput = typeof AddTodoInput.Type;

/** Omitted fields stay as they are. */
export const UpdateTodoInput = Schema.Struct({
  todoId: Schema.String,
  text: Schema.optional(Schema.String),
  done: Schema.optional(Schema.Boolean),
});
export type UpdateTodoInput = typeof UpdateTodoInput.Type;
