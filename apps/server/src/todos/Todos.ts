import {
  ApolloError,
  type BotId,
  type Session,
  type SessionId,
  TODO_LIST_LIMIT,
  TODO_TEXT_LIMIT,
  type TodoItem,
  type TodoList,
  type TodosChange,
} from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { Database } from "../Database.ts";
import { SessionManager } from "../SessionManager.ts";
import { newId, Store } from "../Store.ts";

export type TodoAuthor = "agent" | "user";

/** Changes to one list, applied together: all of them or none. */
export interface TodoOps {
  readonly add?: ReadonlyArray<{ readonly text: string; readonly index?: number | undefined }> | undefined;
  readonly edit?: ReadonlyArray<{ readonly id: string; readonly text: string }> | undefined;
  readonly check?: ReadonlyArray<string> | undefined;
  readonly uncheck?: ReadonlyArray<string> | undefined;
  readonly remove?: ReadonlyArray<string> | undefined;
  /** Listed ids first, in this order; the others keep their order after them. */
  readonly order?: ReadonlyArray<string> | undefined;
  readonly clearDone?: boolean | undefined;
}

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

const cleanText = (text: string) => {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return invalid("a to-do needs some text");
  if (clean.length > TODO_TEXT_LIMIT) return invalid(`keep a to-do under ${TODO_TEXT_LIMIT} characters`);
  return clean;
};

/** `items` with the listed ids first, in that order (unknown ids skipped), then the rest as they were. */
export const reordered = <T extends { readonly id: string }>(items: ReadonlyArray<T>, order: ReadonlyArray<string>): Array<T> => {
  const byId = new Map(items.map((item) => [item.id, item]));
  const first: Array<T> = [];
  for (const id of order) {
    const item = byId.get(id);
    if (!item) continue;
    first.push(item);
    byId.delete(id);
  }
  return [...first, ...items.filter((item) => byId.has(item.id))];
};

/** The list as an agent reads it: one numbered line per item, with its id. */
export const formatTodos = (items: ReadonlyArray<TodoItem>) =>
  items.length === 0
    ? "(empty)"
    : items.map((item, i) => `${i + 1}. [${item.done ? "x" : " "}] ${item.text} (id: ${item.id}${item.addedBy === "user" ? ", added by the user" : ""})`).join("\n");

const quote = (text: string) => `"${text.length > 80 ? `${text.slice(0, 79)}…` : text}"`;

type Row = Record<string, unknown>;

const toItem = (r: Row): TodoItem => ({
  id: r.id as string,
  sessionId: r.session_id as SessionId,
  botId: r.bot_id as BotId,
  text: r.text as string,
  done: Number(r.done) === 1,
  addedBy: r.added_by === "user" ? "user" : "agent",
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/**
 * Each session's to-do list. Its agent keeps it (apollo_todo_*), the user sees it and changes it
 * too; what the user changed is noted on the next message the agent reads.
 */
const make = Effect.gen(function* () {
  const db = yield* Database;
  const store = yield* Store;
  const manager = yield* SessionManager;
  const changes = yield* PubSub.unbounded<TodosChange>();
  /** What the user changed in a list since its agent last read it, oldest first (kept across restarts). */
  const pending = (sessionId: SessionId): Array<string> => {
    const row = db.prepare("select changes from todo_notices where session_id = ?").get(sessionId) as Row | undefined;
    return row ? (JSON.parse(row.changes as string) as Array<string>) : [];
  };
  const setPending = (sessionId: SessionId, changes: ReadonlyArray<string>) => {
    if (changes.length === 0) db.prepare("delete from todo_notices where session_id = ?").run(sessionId);
    else {
      db.prepare("insert into todo_notices (session_id, changes) values (?, ?) on conflict(session_id) do update set changes = excluded.changes").run(
        sessionId,
        JSON.stringify(changes),
      );
    }
  };

  const read = (sessionId: SessionId): Array<TodoItem> =>
    (db.prepare("select * from todos where session_id = ? order by position, created_at").all(sessionId) as Array<Row>).map(toItem);

  const listOf = (session: Pick<Session, "id" | "botId">): TodoList => ({ sessionId: session.id, botId: session.botId, items: read(session.id) });

  /** Writes `next` as the session's whole list. */
  const write = (sessionId: SessionId, before: ReadonlyArray<TodoItem>, next: ReadonlyArray<TodoItem>) => {
    const kept = new Set(next.map((item) => item.id));
    db.exec("begin");
    try {
      for (const item of before) if (!kept.has(item.id)) db.prepare("delete from todos where id = ?").run(item.id);
      const upsert = db.prepare(
        `insert into todos (id, session_id, bot_id, text, done, added_by, position, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set text = excluded.text, done = excluded.done, position = excluded.position, updated_at = excluded.updated_at`,
      );
      next.forEach((item, position) =>
        upsert.run(item.id, sessionId, item.botId, item.text, item.done ? 1 : 0, item.addedBy, position, item.createdAt, item.updatedAt),
      );
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  };

  /** Applies `ops` to the session's list, as `by`; returns the list and the items it added. */
  const apply = (sessionId: SessionId, ops: TodoOps, by: TodoAuthor) =>
    Effect.gen(function* () {
      const session = yield* store.getSession(sessionId);
      const before = read(sessionId);
      let items = [...before];
      const now = Date.now();
      const described: Array<string> = [];
      const find = (id: string) => {
        const item = items.find((i) => i.id === id.trim());
        return item ?? invalid(`no to-do with id ${id} in this list`);
      };
      const replace = (item: TodoItem) => {
        items = items.map((i) => (i.id === item.id ? item : i));
      };

      for (const { id, text } of ops.edit ?? []) {
        const item = find(id);
        if (item instanceof ApolloError) return yield* item;
        const clean = cleanText(text);
        if (clean instanceof ApolloError) return yield* clean;
        if (clean === item.text) continue;
        replace({ ...item, text: clean, updatedAt: now });
        described.push(`reworded ${quote(item.text)} to ${quote(clean)}`);
      }
      for (const [ids, done] of [[ops.check ?? [], true], [ops.uncheck ?? [], false]] as const) {
        for (const id of ids) {
          const item = find(id);
          if (item instanceof ApolloError) return yield* item;
          if (item.done === done) continue;
          replace({ ...item, done, updatedAt: now });
          described.push(`${done ? "checked off" : "unchecked"} ${quote(item.text)}`);
        }
      }
      for (const id of ops.remove ?? []) {
        const item = find(id);
        if (item instanceof ApolloError) return yield* item;
        items = items.filter((i) => i.id !== item.id);
        described.push(`removed ${quote(item.text)}`);
      }
      if (ops.clearDone) {
        const done = items.filter((i) => i.done);
        items = items.filter((i) => !i.done);
        if (done.length > 0) described.push(`removed the checked items (${done.map((i) => quote(i.text)).join(", ")})`);
      }
      if (ops.order && ops.order.length > 0) {
        const next = reordered(items, ops.order.map((id) => id.trim()));
        if (next.some((item, i) => item !== items[i])) described.push("reordered the list");
        items = next;
      }
      const added: Array<TodoItem> = [];
      for (const { text, index } of ops.add ?? []) {
        const clean = cleanText(text);
        if (clean instanceof ApolloError) return yield* clean;
        const item: TodoItem = {
          id: newId("todo"),
          sessionId,
          botId: session.botId,
          text: clean,
          done: false,
          addedBy: by,
          createdAt: now,
          updatedAt: now,
        };
        const at = index === undefined || !Number.isFinite(index) ? items.length : Math.min(Math.max(Math.round(index), 0), items.length);
        items.splice(at, 0, item);
        added.push(item);
        described.push(`added ${quote(clean)}`);
      }
      if (items.length > TODO_LIST_LIMIT) {
        return yield* invalid(`a to-do list holds at most ${TODO_LIST_LIMIT} items: remove finished ones first`);
      }

      if (described.length > 0) {
        write(sessionId, before, items);
        const list = { sessionId, botId: session.botId, items };
        yield* PubSub.publish(changes, { _tag: "TodoListChanged", list });
        if (by === "user") setPending(sessionId, [...pending(sessionId), ...described]);
      }
      // The agent sees the whole list in its tool's answer.
      if (by === "agent") setPending(sessionId, []);
      return { list: { sessionId, botId: session.botId, items } as TodoList, added };
    });

  const sessionOf = (todoId: string) =>
    Effect.suspend(() => {
      const row = db.prepare("select session_id from todos where id = ?").get(todoId) as Row | undefined;
      return row ? Effect.succeed(row.session_id as SessionId) : Effect.fail(new ApolloError({ code: "not_found", message: `to-do ${todoId} not found` }));
    });

  const itemIn = (list: TodoList, id: string) => list.items.find((i) => i.id === id)!;

  yield* manager.addMessageNote((session) =>
    Effect.sync(() => {
      const described = pending(session.id);
      if (described.length === 0) return null;
      return {
        text: [`[Apollo] The user changed your to-do list: ${described.join("; ")}. It now reads:`, formatTodos(read(session.id))].join("\n"),
        // Changes made while the message was on its way stay for the next one. If the agent read
        // the list meanwhile, the delivered ones are already gone.
        delivered: Effect.sync(() => {
          const now = pending(session.id);
          if (described.every((d, i) => now[i] === d)) setPending(session.id, now.slice(described.length));
        }),
      };
    }),
  );

  return {
    apply,
    /** The session's list (`by` "agent": its agent read it, so the user's changes are no longer news). */
    list: (sessionId: SessionId, by: TodoAuthor) =>
      Effect.gen(function* () {
        const session = yield* store.getSession(sessionId);
        if (by === "agent") setPending(sessionId, []);
        return listOf(session);
      }),

    // The user's edits, from the UI.
    add: (sessionId: SessionId, text: string, index?: number) =>
      Effect.map(apply(sessionId, { add: [{ text, index }] }, "user"), ({ added }) => added[0]!),
    update: (todoId: string, fields: { readonly text?: string | undefined; readonly done?: boolean | undefined }) =>
      Effect.gen(function* () {
        const sessionId = yield* sessionOf(todoId);
        const { list } = yield* apply(
          sessionId,
          {
            ...(fields.text !== undefined ? { edit: [{ id: todoId, text: fields.text }] } : {}),
            ...(fields.done === true ? { check: [todoId] } : fields.done === false ? { uncheck: [todoId] } : {}),
          },
          "user",
        );
        return itemIn(list, todoId);
      }),
    remove: (todoId: string) =>
      Effect.gen(function* () {
        const sessionId = yield* sessionOf(todoId);
        yield* apply(sessionId, { remove: [todoId] }, "user");
      }),
    reorder: (sessionId: SessionId, todoIds: ReadonlyArray<string>) =>
      Effect.map(apply(sessionId, { order: todoIds }, "user"), ({ list }) => list),
    clearDone: (sessionId: SessionId) => Effect.map(apply(sessionId, { clearDone: true }, "user"), ({ list }) => list),

    /** `todos.watch`: every non-empty list, then each list that changed, without gaps. */
    watch: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const items = (db.prepare("select * from todos order by session_id, position, created_at").all() as Array<Row>).map(toItem);
        const lists = new Map<SessionId, TodoList & { items: Array<TodoItem> }>();
        for (const item of items) {
          const list = lists.get(item.sessionId) ?? { sessionId: item.sessionId, botId: item.botId, items: [] };
          list.items.push(item);
          lists.set(item.sessionId, list);
        }
        const first: TodosChange = { _tag: "TodosSnapshot", lists: [...lists.values()] };
        return Stream.concat(Stream.succeed(first), Stream.fromSubscription(subscription));
      }),
    ) as Stream.Stream<TodosChange>,
  };
});

export class Todos extends Context.Service<Todos, Effect.Success<typeof make>>()("apollo/Todos") {}

export const layer = Layer.effect(Todos, make);
