import type { SessionId, TodoItem, TodosChange } from "@apollo/contracts";

/** Each session's to-do items, first to last. */
export type TodoLists = ReadonlyMap<SessionId, ReadonlyArray<TodoItem>>;

/** Applies one item of `todos.watch`: each (re)connection starts with every list. */
export const applyTodos = (lists: TodoLists, change: TodosChange): TodoLists => {
  if (change._tag === "TodosSnapshot") return new Map(change.lists.map((l) => [l.sessionId, l.items]));
  const next = new Map(lists);
  if (change.list.items.length === 0) next.delete(change.list.sessionId);
  else next.set(change.list.sessionId, change.list.items);
  return next;
};

/** How far along a list is, and the item being worked on (the first open one). */
export const todoProgress = (items: ReadonlyArray<TodoItem>) => ({
  done: items.filter((i) => i.done).length,
  total: items.length,
  current: items.find((i) => !i.done) ?? null,
});

/** The list's ids with the item at `from` moved to `to`. */
export const movedTodoIds = (items: ReadonlyArray<Pick<TodoItem, "id">>, from: number, to: number): Array<string> => {
  const ids = items.map((i) => i.id);
  if (from < 0 || from >= ids.length) return ids;
  const [moved] = ids.splice(from, 1);
  ids.splice(Math.min(Math.max(to, 0), ids.length), 0, moved!);
  return ids;
};
