import { movedTodoIds, todoProgress } from "@apollo/client";
import { type SessionId, TODO_TEXT_LIMIT, type TodoItem } from "@apollo/contracts";
import type * as Effect from "effect/Effect";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useApollo } from "./AppState.tsx";
import { type ApolloClient, errorMessage } from "./connection.ts";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, ListTodoIcon, PlusIcon, TrashIcon } from "./icons.tsx";
import { animateLayout, FadeIn, Turn } from "./motion.tsx";
import { useKeyboardHeight } from "./MonitorStrip.tsx";
import { colors } from "./theme.ts";

const EMPTY: ReadonlyArray<TodoItem> = [];
const sky = "#38bdf8";
/** Open, the list scrolls past this share of the screen above the keyboard. */
const MAX_SHARE = 0.4;

type Call = (client: ApolloClient) => Effect.Effect<unknown, unknown>;

export const useTodos = (sessionId: SessionId) => {
  const { state } = useApollo();
  return state.todos.get(sessionId) ?? EMPTY;
};

/**
 * Above the message box: the agent's to-do list for this conversation (as the desktop app's
 * TodoStrip). Folded, it shows progress and the item being worked on; open, the user adds, edits,
 * checks off, reorders and removes items. The agent is told what the user changed with its next message.
 */
export function TodoStrip({ sessionId, open, onToggle }: { sessionId: SessionId; open: boolean; onToggle: () => void }) {
  const { connection } = useApollo();
  const items = useTodos(sessionId);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const { height } = useWindowDimensions();
  const keyboard = useKeyboardHeight();
  if (items.length === 0 && !open) return null;
  const { done, total, current } = todoProgress(items);

  const act = (call: Call) => {
    setError(null);
    return connection.rpc(call).catch((e: unknown) => setError(errorMessage(e)));
  };

  return (
    <FadeIn>
      <View style={styles.card}>
        <Pressable
          style={styles.header}
          onPress={() => {
            animateLayout();
            setEditing(null);
            onToggle();
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={total > 0 ? `To-do list, ${done} of ${total} done` : "To-do list, empty"}
        >
          <ListTodoIcon size={16} color={sky} />
          <Text style={styles.title}>To-do</Text>
          {total > 0 ? (
            <>
              <Text style={styles.count}>
                {done}/{total}
              </Text>
              <View style={styles.bar}>
                <View style={[styles.barFill, { width: `${(done / total) * 100}%` }]} />
              </View>
              <Text style={styles.current} numberOfLines={1}>
                {current ? current.text : "All done"}
              </Text>
            </>
          ) : (
            <Text style={[styles.current, { color: colors.faint }]}>Empty</Text>
          )}
          <Turn open={open} degrees={180}>
            <ChevronDownIcon size={15} color={colors.faint} />
          </Turn>
        </Pressable>
        {open ? (
          <View style={styles.body}>
            <ScrollView
              style={{ maxHeight: Math.round(Math.max(0, height - keyboard) * MAX_SHARE) }}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              {items.map((item, index) => (
                <TodoRow
                  key={item.id}
                  item={item}
                  editing={editing === item.id}
                  first={index === 0}
                  last={index === items.length - 1}
                  onEdit={(on) => {
                    animateLayout();
                    setEditing(on ? item.id : null);
                  }}
                  onAct={act}
                  onMove={(by) => {
                    animateLayout();
                    void act((c) => c["todos.reorder"]({ sessionId, todoIds: movedTodoIds(items, index, index + by) }));
                  }}
                />
              ))}
            </ScrollView>
            <AddTodo sessionId={sessionId} onAct={act} />
            {error || done > 0 ? (
              <View style={styles.footer}>
                <Text style={styles.error} numberOfLines={2}>
                  {error ?? ""}
                </Text>
                {done > 0 ? (
                  <Pressable
                    onPress={() => {
                      animateLayout();
                      void act((c) => c["todos.clearDone"]({ sessionId }));
                    }}
                    hitSlop={6}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.clear, pressed && { opacity: 0.5 }]}
                  >
                    <Text style={styles.clearText}>Clear done ({done})</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </FadeIn>
  );
}

function TodoRow({
  item,
  editing,
  first,
  last,
  onEdit,
  onAct,
  onMove,
}: {
  item: TodoItem;
  editing: boolean;
  first: boolean;
  last: boolean;
  onEdit: (on: boolean) => void;
  onAct: (call: Call) => Promise<unknown>;
  onMove: (by: number) => void;
}) {
  const [draft, setDraft] = useState(item.text);
  const save = () => {
    onEdit(false);
    const text = draft.trim();
    if (!text || text === item.text) return setDraft(item.text);
    void onAct((c) => c["todos.update"]({ todoId: item.id, text }));
  };
  return (
    <View style={[styles.row, editing && styles.rowEditing]}>
      <Pressable
        onPress={() => void onAct((c) => c["todos.update"]({ todoId: item.id, done: !item.done }))}
        hitSlop={8}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.done }}
        accessibilityLabel={item.text}
        style={[styles.check, item.done && styles.checkDone]}
      >
        {item.done ? <CheckIcon size={12} color="#fff" strokeWidth={3} /> : null}
      </Pressable>
      {editing ? (
        <>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            autoFocus
            maxLength={TODO_TEXT_LIMIT}
            onSubmitEditing={save}
            onBlur={save}
            returnKeyType="done"
            style={styles.input}
            accessibilityLabel="To-do text"
          />
          <RowButton label="Move up" disabled={first} onPress={() => onMove(-1)}>
            <ArrowUpIcon size={15} color={colors.textSoft} />
          </RowButton>
          <RowButton label="Move down" disabled={last} onPress={() => onMove(1)}>
            <ArrowDownIcon size={15} color={colors.textSoft} />
          </RowButton>
          <RowButton
            label="Remove"
            onPress={() => {
              onEdit(false);
              void onAct((c) => c["todos.remove"]({ todoId: item.id }));
            }}
          >
            <TrashIcon size={15} color={colors.red} />
          </RowButton>
        </>
      ) : (
        <Pressable
          style={styles.textButton}
          onPress={() => {
            setDraft(item.text);
            onEdit(true);
          }}
          accessibilityRole="button"
          accessibilityHint="Edit, move or remove it"
        >
          <Text style={[styles.text, item.done && styles.textDone]}>{item.text}</Text>
        </Pressable>
      )}
    </View>
  );
}

function RowButton({ label, disabled, onPress, children }: { label: string; disabled?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.rowButton, (pressed || disabled) && { opacity: disabled ? 0.3 : 0.5 }]}
    >
      {children}
    </Pressable>
  );
}

function AddTodo({ sessionId, onAct }: { sessionId: SessionId; onAct: (call: Call) => Promise<unknown> }) {
  const [text, setText] = useState("");
  const add = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    animateLayout();
    void onAct((c) => c["todos.add"]({ sessionId, text: value }));
  };
  return (
    <View style={styles.add}>
      <PlusIcon size={14} color={colors.faint} />
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={add}
        submitBehavior="submit"
        maxLength={TODO_TEXT_LIMIT}
        placeholder="Add a to-do…"
        placeholderTextColor={colors.faint}
        returnKeyType="done"
        style={styles.addInput}
        accessibilityLabel="Add a to-do"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 10,
    marginTop: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(24,24,27,0.85)",
  },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 9 },
  title: { color: colors.text, fontSize: 13, fontWeight: "600" },
  count: { color: colors.faint, fontSize: 12, fontVariant: ["tabular-nums"] },
  bar: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, overflow: "hidden" },
  barFill: { height: 4, borderRadius: 2, backgroundColor: sky },
  current: { flex: 1, minWidth: 0, color: colors.muted, fontSize: 12 },
  body: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: 6, paddingTop: 4, paddingBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 6, paddingVertical: 6, borderRadius: 10 },
  rowEditing: { backgroundColor: "rgba(56,189,248,0.08)" },
  check: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.faint,
    alignItems: "center",
    justifyContent: "center",
  },
  checkDone: { backgroundColor: sky, borderColor: sky },
  textButton: { flex: 1, minWidth: 0 },
  text: { color: colors.textSoft, fontSize: 14 },
  textDone: { color: colors.faint, textDecorationLine: "line-through" },
  input: {
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 14,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: colors.bubble,
  },
  rowButton: { padding: 5 },
  add: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 9, paddingTop: 2 },
  addInput: { flex: 1, color: colors.text, fontSize: 14, paddingVertical: 6 },
  footer: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingTop: 2 },
  error: { flex: 1, color: colors.red, fontSize: 11 },
  clear: { paddingHorizontal: 6, paddingVertical: 3 },
  clearText: { color: colors.faint, fontSize: 12 },
});
