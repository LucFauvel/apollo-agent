import type { BotId, SessionId, TodoItem } from "@apollo/contracts";
import { describe, expect, it } from "vitest";
import { applyTodos, movedTodoIds, todoProgress } from "../src/todos.ts";

const item = (id: string, done = false, sessionId = "s1"): TodoItem => ({
  id,
  sessionId: sessionId as SessionId,
  botId: "b1" as BotId,
  text: id,
  done,
  addedBy: "agent",
  createdAt: 0,
  updatedAt: 0,
});

describe("to-do lists", () => {
  it("replaces lists on a snapshot, and one list on a change", () => {
    const start = applyTodos(new Map(), {
      _tag: "TodosSnapshot",
      lists: [{ sessionId: "s1" as SessionId, botId: "b1" as BotId, items: [item("a")] }],
    });
    expect(start.get("s1" as SessionId)?.map((i) => i.id)).toEqual(["a"]);
    const changed = applyTodos(start, {
      _tag: "TodoListChanged",
      list: { sessionId: "s2" as SessionId, botId: "b1" as BotId, items: [item("b", false, "s2")] },
    });
    expect([...changed.keys()]).toEqual(["s1", "s2"]);
    const emptied = applyTodos(changed, { _tag: "TodoListChanged", list: { sessionId: "s1" as SessionId, botId: "b1" as BotId, items: [] } });
    expect([...emptied.keys()]).toEqual(["s2"]);
  });

  it("counts progress and finds the current item", () => {
    expect(todoProgress([item("a", true), item("b"), item("c")])).toMatchObject({ done: 1, total: 3, current: { id: "b" } });
    expect(todoProgress([item("a", true)]).current).toBeNull();
  });

  it("moves an item", () => {
    const items = [item("a"), item("b"), item("c")];
    expect(movedTodoIds(items, 0, 2)).toEqual(["b", "c", "a"]);
    expect(movedTodoIds(items, 2, 0)).toEqual(["c", "a", "b"]);
    expect(movedTodoIds(items, 1, 9)).toEqual(["a", "c", "b"]);
    expect(movedTodoIds(items, 5, 0)).toEqual(["a", "b", "c"]);
  });
});
