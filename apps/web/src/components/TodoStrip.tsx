import { movedTodoIds, todoProgress } from "@apollo/client";
import { TODO_TEXT_LIMIT, type Session, type TodoItem } from "@apollo/contracts";
import { Check, ChevronDown, GripVertical, ListTodo, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as Effect from "effect/Effect";
import { type ApolloClient, errorMessage, rpc } from "../rpc.ts";
import { useApp } from "../store.ts";
import { Collapse, cx, IconButton } from "./ui.tsx";

const EMPTY: ReadonlyArray<TodoItem> = [];

type Call = (client: ApolloClient) => Effect.Effect<unknown, unknown>;

/** Sessions whose to-do list is open (expanded), from the strip or the header button. */
let opened = new Set<string>();
const listeners = new Set<() => void>();

export const setTodosOpen = (sessionId: string, open: boolean) => {
  opened = new Set(opened);
  if (open) opened.add(sessionId);
  else opened.delete(sessionId);
  listeners.forEach((l) => l());
};

export const useTodosOpen = (sessionId: string) =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => opened.has(sessionId),
  );

export const useTodos = (sessionId: string) => useApp((s) => s.todos.get(sessionId as Session["id"]) ?? EMPTY);

/**
 * Above the message box: the agent's to-do list for this conversation. Folded, it shows progress
 * and the item being worked on; open, the user adds, edits, checks off, reorders and removes
 * items. The agent is told what the user changed with its next message.
 */
export function TodoStrip({ session }: { session: Session }) {
  const items = useTodos(session.id);
  const open = useTodosOpen(session.id);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  if (items.length === 0 && !open) return null;
  const { done, total, current } = todoProgress(items);

  const act = (call: Call) => {
    setError(null);
    return rpc(call).catch((e: unknown) => setError(errorMessage(e)));
  };
  const move = (from: number, to: number) => {
    if (from === to) return;
    void act((c) => c["todos.reorder"]({ sessionId: session.id, todoIds: movedTodoIds(items, from, to) }));
  };

  return (
    <div className="animate-pop-in mb-2 rounded-xl border border-zinc-800 bg-zinc-900/60">
      <button
        type="button"
        onClick={() => setTodosOpen(session.id, !open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <ListTodo className="size-4 shrink-0 text-sky-300" strokeWidth={1.75} aria-hidden />
        <span className="shrink-0 text-xs font-medium text-zinc-200">To-do</span>
        {total > 0 ? (
          <>
            <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">
              {done}/{total}
            </span>
            <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-zinc-800">
              <span className="block h-full rounded-full bg-sky-400 transition-[width] duration-300" style={{ width: `${(done / total) * 100}%` }} />
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{current ? current.text : "All done"}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">Empty</span>
        )}
        <ChevronDown className={cx("size-3.5 shrink-0 text-zinc-500 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      <Collapse open={open}>
        <div className="border-t border-zinc-800/80 px-1.5 pt-1 pb-1.5">
          <ol className="max-h-64 overflow-y-auto">
            {items.map((item, index) => (
              <TodoRow
                key={item.id}
                item={item}
                index={index}
                count={items.length}
                dropTarget={dragging !== null && over === index && dragging !== index}
                onAct={act}
                onMove={move}
                onDragStart={() => setDragging(index)}
                onDragOver={() => setOver(index)}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onDrop={() => {
                  if (dragging !== null) move(dragging, index);
                  setDragging(null);
                  setOver(null);
                }}
              />
            ))}
          </ol>
          <AddTodo sessionId={session.id} onAct={act} autoFocus={items.length === 0} />
          <div className="flex items-center gap-2 px-1.5 pt-1">
            {error ? <span className="min-w-0 flex-1 truncate text-[11px] text-red-400">{error}</span> : <span className="flex-1" />}
            {done > 0 ? (
              <button
                type="button"
                onClick={() => void act((c) => c["todos.clearDone"]({ sessionId: session.id }))}
                className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              >
                Clear done ({done})
              </button>
            ) : null}
          </div>
        </div>
      </Collapse>
    </div>
  );
}

function TodoRow({
  item,
  index,
  count,
  dropTarget,
  onAct,
  onMove,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: {
  item: TodoItem;
  index: number;
  count: number;
  dropTarget: boolean;
  onAct: (call: Call) => Promise<unknown>;
  onMove: (from: number, to: number) => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [draggable, setDraggable] = useState(false);

  const save = () => {
    setEditing(false);
    const text = draft.trim();
    if (!text || text === item.text) return setDraft(item.text);
    void onAct((c) => c["todos.update"]({ todoId: item.id, text }));
  };

  return (
    <li
      draggable={draggable && !editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.text);
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDragEnd={() => {
        setDraggable(false);
        onDragEnd();
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDraggable(false);
        onDrop();
      }}
      className={cx(
        "group flex items-center gap-1.5 rounded-lg px-1 py-0.5 transition-colors hover:bg-zinc-800/50",
        dropTarget && "bg-sky-500/10 ring-1 ring-sky-500/40",
      )}
    >
      <button
        type="button"
        aria-label={`Move "${item.text}" (drag, or use the arrow keys)`}
        title="Drag to reorder (or focus and use ↑ ↓)"
        onMouseDown={() => setDraggable(true)}
        onMouseUp={() => setDraggable(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" && index > 0) {
            e.preventDefault();
            onMove(index, index - 1);
          } else if (e.key === "ArrowDown" && index < count - 1) {
            e.preventDefault();
            onMove(index, index + 1);
          }
        }}
        className="flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-zinc-600 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" />
      </button>
      <button
        type="button"
        role="checkbox"
        aria-checked={item.done}
        aria-label={item.done ? `Uncheck "${item.text}"` : `Check off "${item.text}"`}
        onClick={() => void onAct((c) => c["todos.update"]({ todoId: item.id, done: !item.done }))}
        className={cx(
          "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
          item.done ? "border-sky-500 bg-sky-500 text-white" : "border-zinc-600 hover:border-zinc-400",
        )}
      >
        {item.done ? <Check className="size-3" strokeWidth={3} /> : null}
      </button>
      {editing ? (
        <input
          autoFocus
          value={draft}
          maxLength={TODO_TEXT_LIMIT}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            else if (e.key === "Escape") {
              setDraft(item.text);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-100 outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(item.text);
            setEditing(true);
          }}
          title={item.addedBy === "user" ? "Added by you · click to edit" : "Click to edit"}
          className={cx(
            "min-w-0 flex-1 truncate py-0.5 text-left text-xs transition-colors",
            item.done ? "text-zinc-500 line-through" : "text-zinc-200",
          )}
        >
          {item.text}
        </button>
      )}
      <IconButton
        icon={X}
        label={`Remove "${item.text}"`}
        size="sm"
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => void onAct((c) => c["todos.remove"]({ todoId: item.id }))}
      />
    </li>
  );
}

function AddTodo({ sessionId, onAct, autoFocus }: { sessionId: Session["id"]; onAct: (call: Call) => Promise<unknown>; autoFocus: boolean }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  const add = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    void onAct((c) => c["todos.add"]({ sessionId, text: value }));
  };
  return (
    <div className="mt-0.5 flex items-center gap-1.5 px-1">
      <Plus className="ml-1.5 size-3.5 shrink-0 text-zinc-600" aria-hidden />
      <input
        ref={input}
        value={text}
        maxLength={TODO_TEXT_LIMIT}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
        placeholder="Add a to-do…"
        aria-label="Add a to-do"
        className="min-w-0 flex-1 bg-transparent py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
      />
    </div>
  );
}
