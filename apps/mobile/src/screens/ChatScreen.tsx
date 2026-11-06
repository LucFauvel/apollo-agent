import {
  reduceTranscript,
  type TranscriptItem,
  type TranscriptState,
} from "@apollo/client";
import type { InputField, InputValue, SessionId } from "@apollo/contracts";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useApollo } from "../AppState.tsx";
import { BlobAvatar } from "../BlobAvatar.tsx";
import { Markdown } from "../Markdown.tsx";
import { animateLayout, FadeIn, useKeyboardInset } from "../motion.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { errorMessage } from "../connection.ts";
import { colors } from "../theme.ts";

type Action =
  | { type: "event"; event: Parameters<typeof reduceTranscript>[1] }
  | { type: "reset"; sessionId: SessionId };
const reducer = (state: TranscriptState, action: Action): TranscriptState =>
  action.type === "reset"
    ? { sessionId: action.sessionId, lastSeq: 0, items: [] }
    : reduceTranscript(state, action.event);

/** Lets a row that opens or closes keep the transcript from jumping to the bottom. */
const ScrollHold = createContext<() => void>(() => {});

/** Opens or closes a section with an animation, without scrolling the transcript. */
const useToggle = () => {
  const [open, setOpen] = useState(false);
  const hold = useContext(ScrollHold);
  return [
    open,
    () => {
      hold();
      animateLayout();
      setOpen((o) => !o);
    },
  ] as const;
};

/** A conversation: its live transcript, cards that need the user, and a message box. */
export function ChatScreen({
  sessionId,
  onBack,
}: {
  sessionId: SessionId;
  onBack: () => void;
}) {
  const { state, connection } = useApollo();
  const session = state.sessions.get(sessionId);
  const bot = session ? state.bots.get(session.botId) : undefined;
  const [transcript, dispatch] = useReducer(reducer, {
    sessionId,
    lastSeq: 0,
    items: [],
  });
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  // Follow new output only while the user is at the bottom, and never because a row opened.
  const atBottom = useRef(true);
  const holdUntil = useRef(0);
  const hold = useMemo(
    () => () => void (holdUntil.current = Date.now() + 700),
    [],
  );
  // Rows already there when the conversation opens appear at once; later ones fade in.
  const openedAt = useRef(Date.now());
  const lastSeq = useRef(0);
  // Lift the conversation and the message box above the keyboard, and show the latest message.
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset(insets.bottom, () => setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50));

  useEffect(() => {
    dispatch({ type: "reset", sessionId });
    lastSeq.current = 0;
    openedAt.current = Date.now();
    atBottom.current = true;
  }, [sessionId]);

  // Resumes after the last event seen, so a reconnect does not reload the conversation.
  useEffect(
    () =>
      connection.follow(
        (client) =>
          client["sessions.events"]({ sessionId, afterSeq: lastSeq.current }),
        (event) => {
          if (event.seq <= lastSeq.current) return;
          lastSeq.current = event.seq;
          dispatch({ type: "event", event });
        },
      ),
    [connection, sessionId],
  );

  const working =
    session?.status === "running" || session?.status === "starting";
  const act = (f: Parameters<typeof connection.rpc>[0]) => {
    setError(null);
    connection.rpc(f).catch((e) => setError(errorMessage(e)));
  };
  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    setError(null);
    connection
      .rpc((c) => c["sessions.send"]({ sessionId, text: value }))
      .catch((e) => {
        setError(errorMessage(e));
        setText(value);
      });
  };

  const items = useMemo(
    () => transcript.items.filter((i) => i.kind !== "turn-end"),
    [transcript.items],
  );
  const count = items.length;
  useEffect(() => {
    if (count && Date.now() - openedAt.current > 1000) animateLayout(180);
  }, [count]);

  return (
    <Animated.View style={[styles.screen, { paddingBottom: keyboard }]}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        {bot ? <BlobAvatar avatar={bot.avatar} size={32} /> : null}
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {session?.role === "main"
              ? (bot?.name ?? "Bot")
              : (session?.title ?? "Session")}
          </Text>
          <Text style={styles.headerMeta}>
            {session?.status === "waiting-approval"
              ? "Needs you"
              : working
                ? "Working…"
                : (session?.provider ?? "")}
          </Text>
        </View>
      </View>

      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={styles.transcript}
        scrollEventThrottle={64}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onScroll={({ nativeEvent: e }) => {
          atBottom.current =
            e.contentOffset.y + e.layoutMeasurement.height >=
            e.contentSize.height - 120;
        }}
        onContentSizeChange={() => {
          if (atBottom.current && Date.now() > holdUntil.current)
            scroll.current?.scrollToEnd({ animated: true });
        }}
      >
        <ScrollHold.Provider value={hold}>
          {items.map((item) => (
            <FadeIn
              key={item.key}
              animate={Date.now() - openedAt.current > 1000}
            >
              <Item
                item={item}
                onApprove={(requestId, decision) =>
                  act((c) =>
                    c["sessions.respondApproval"]({
                      sessionId,
                      requestId,
                      decision,
                    }),
                  )
                }
                onInput={(requestId, response) =>
                  act((c) =>
                    c["sessions.respondInput"]({
                      sessionId,
                      requestId,
                      response,
                    }),
                  )
                }
                onSecret={(requestId, value) =>
                  act((c) =>
                    c["secrets.respond"]({
                      sessionId,
                      requestId,
                      response:
                        value === null
                          ? { _tag: "decline" }
                          : { _tag: "typed", value },
                    }),
                  )
                }
              />
            </FadeIn>
          ))}
        </ScrollHold.Provider>
        {working && items.at(-1)?.kind === "user" ? (
          <View style={styles.working}>
            <ActivityIndicator size="small" color={colors.muted} />
            <Text style={styles.workingText}>Working…</Text>
          </View>
        ) : null}
      </ScrollView>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={`Message ${bot?.name ?? "Apollo"}…`}
          placeholderTextColor={colors.faint}
          multiline
        />
        {working ? (
          <Pressable
            style={[styles.sendButton, styles.stop]}
            onPress={() => act((c) => c["sessions.interrupt"]({ sessionId }))}
          >
            <Text style={styles.stopText}>■</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[styles.sendButton, !text.trim() && styles.disabled]}
          onPress={send}
          disabled={!text.trim()}
        >
          <Text style={styles.sendText}>↑</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

function Item({
  item,
  onApprove,
  onInput,
  onSecret,
}: {
  item: TranscriptItem;
  onApprove: (
    requestId: string,
    decision: "accept" | "accept-for-session" | "decline",
  ) => void;
  onInput: (
    requestId: string,
    response: {
      action: "accept" | "decline";
      values: Record<string, InputValue>;
    },
  ) => void;
  onSecret: (requestId: string, value: string | null) => void;
}) {
  switch (item.kind) {
    case "user":
      return item.author === "user" ? (
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{item.text}</Text>
        </View>
      ) : (
        <SystemCard
          label={item.author === "bot" ? "Orchestrator" : "Apollo"}
          text={item.text.replace(/^\[Apollo\]\s*/, "")}
        />
      );
    case "assistant":
      return item.text.trim() === "[SILENT]" ? null : (
        <Markdown text={item.text} />
      );
    case "reasoning":
      return <Reasoning item={item} />;
    case "tool":
      return <ToolCall item={item} />;
    case "notice":
      return (
        <Text
          style={[
            styles.notice,
            item.level === "error" && { color: colors.red },
          ]}
        >
          {item.message}
        </Text>
      );
    case "approval":
      return (
        <View
          style={[styles.card, item.decision === null && styles.cardPending]}
        >
          <Text style={styles.cardTitle}>{item.title}</Text>
          {item.detail ? (
            <Text style={styles.code} numberOfLines={6}>
              {item.detail}
            </Text>
          ) : null}
          {item.decision === null ? (
            <View style={styles.buttons}>
              <Button
                label="Allow"
                primary
                onPress={() => onApprove(item.requestId, "accept")}
              />
              <Button
                label="For session"
                onPress={() => onApprove(item.requestId, "accept-for-session")}
              />
              <Button
                label="Decline"
                onPress={() => onApprove(item.requestId, "decline")}
              />
            </View>
          ) : (
            <Text style={styles.resolved}>
              {item.decision === "decline" ? "Declined" : "Allowed"}
            </Text>
          )}
        </View>
      );
    case "input":
      return <InputCard item={item} onInput={onInput} />;
    case "secret":
      return <SecretCard item={item} onSecret={onSecret} />;
    case "visual":
    case "recording":
      return (
        <Text style={styles.notice}>
          {item.title}: open Apollo on your computer to view it.
        </Text>
      );
    default:
      return null;
  }
}

/** A chevron that turns when its section opens. */
const Chevron = ({ open }: { open: boolean }) => (
  <Text style={styles.chevron}>{open ? "▾" : "▸"}</Text>
);

/** Messages from the orchestrator or Apollo (worker reports): collapsed to a preview, tap to read. */
function SystemCard({ label, text }: { label: string; text: string }) {
  const [open, toggle] = useToggle();
  return (
    <Pressable style={styles.systemCard} onPress={toggle}>
      <View style={styles.rowCenter}>
        <Chevron open={open} />
        <Text style={styles.systemLabel}>{label}</Text>
      </View>
      {open ? (
        <Markdown text={text} color={colors.muted} size={13} />
      ) : (
        <Text style={styles.systemText} numberOfLines={2}>
          {text.replace(/[#*`>_]+/g, "").replace(/\s+/g, " ")}
        </Text>
      )}
    </Pressable>
  );
}

/** The agent's thinking: one line while it streams, the whole text on tap. */
function Reasoning({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "reasoning" }>;
}) {
  const [open, toggle] = useToggle();
  return (
    <Pressable onPress={toggle} hitSlop={6} style={{ gap: 6 }}>
      <View style={styles.rowCenter}>
        <Chevron open={open} />
        <Text style={styles.activity} numberOfLines={1}>
          {item.streaming
            ? open
              ? "Thinking…"
              : `Thinking… ${item.text.replace(/\s+/g, " ").slice(-70)}`
            : "Thought"}
        </Text>
      </View>
      {open ? (
        <View style={styles.expanded}>
          <Markdown text={item.text} color={colors.faint} size={13} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** A tool call: name and summary on one line, its output on tap. */
function ToolCall({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "tool" }>;
}) {
  const [open, toggle] = useToggle();
  const name = item.name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  return (
    <Pressable onPress={toggle} hitSlop={6} style={{ gap: 6 }}>
      <View style={styles.rowCenter}>
        <Chevron open={open} />
        <Text
          style={[
            styles.activity,
            { flex: 1 },
            item.isError && { color: colors.red },
          ]}
          numberOfLines={open ? undefined : 1}
        >
          {item.output === null ? "⏳" : item.isError ? "✗" : "✓"} {name}{" "}
          <Text style={styles.activityDetail}>{item.summary}</Text>
        </Text>
      </View>
      {open ? (
        <ScrollView
          horizontal
          style={styles.toolOutput}
          contentContainerStyle={{ padding: 8 }}
        >
          <Text
            style={[
              styles.toolOutputText,
              item.isError && { color: colors.red },
            ]}
            selectable
          >
            {item.output === null
              ? "Running…"
              : item.output.trim()
                ? item.output.slice(0, 6000)
                : "(no output)"}
          </Text>
        </ScrollView>
      ) : null}
    </Pressable>
  );
}

function Button({
  label,
  onPress,
  primary,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      style={[styles.button, primary && styles.buttonPrimary]}
      onPress={onPress}
    >
      <Text style={[styles.buttonText, primary && styles.buttonTextPrimary]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Questions from the agent (AskUserQuestion, MCP forms): choices as buttons, text as inputs. */
function InputCard({
  item,
  onInput,
}: {
  item: Extract<TranscriptItem, { kind: "input" }>;
  onInput: (
    requestId: string,
    response: {
      action: "accept" | "decline";
      values: Record<string, InputValue>;
    },
  ) => void;
}) {
  const [values, setValues] = useState<Record<string, InputValue>>({});
  if (item.action !== null) {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{item.message}</Text>
        <Text style={styles.resolved}>
          {item.action === "accept" ? "Answered" : "Dismissed"}
        </Text>
      </View>
    );
  }
  const field = (f: InputField) => {
    if (f.kind === "select" || f.kind === "multi-select") {
      const selected = values[f.name];
      return (
        <View key={f.name} style={{ gap: 6 }}>
          <Text style={styles.fieldTitle}>{f.title}</Text>
          {f.options.map((o) => {
            const on = Array.isArray(selected)
              ? selected.includes(o.value)
              : selected === o.value;
            const [label, ...rest] = o.label.split(" — ");
            return (
              <Pressable
                key={o.value}
                style={[styles.option, on && styles.optionOn]}
                onPress={() =>
                  setValues((v) => {
                    if (f.kind === "select")
                      return { ...v, [f.name]: on ? "" : o.value };
                    const list = Array.isArray(v[f.name])
                      ? (v[f.name] as Array<string>)
                      : [];
                    return {
                      ...v,
                      [f.name]: on
                        ? list.filter((x) => x !== o.value)
                        : [...list, o.value],
                    };
                  })
                }
              >
                <Text style={styles.optionLabel}>{label}</Text>
                {rest.length ? (
                  <Text style={styles.optionDetail}>{rest.join(" — ")}</Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      );
    }
    if (f.kind === "boolean") {
      const on = values[f.name] === true;
      return (
        <Pressable
          key={f.name}
          style={[styles.option, on && styles.optionOn]}
          onPress={() => setValues((v) => ({ ...v, [f.name]: !on }))}
        >
          <Text style={styles.optionLabel}>{f.title}</Text>
        </Pressable>
      );
    }
    return (
      <View key={f.name} style={{ gap: 6 }}>
        <Text style={styles.fieldTitle}>{f.title}</Text>
        <TextInput
          style={styles.input}
          secureTextEntry={f.secret}
          keyboardType={f.kind === "string" ? "default" : "numeric"}
          value={
            typeof values[f.name] === "string" ? (values[f.name] as string) : ""
          }
          onChangeText={(t) =>
            setValues((v) => ({
              ...v,
              [f.name]: f.kind === "string" ? t : t === "" ? "" : Number(t),
            }))
          }
          placeholderTextColor={colors.faint}
        />
      </View>
    );
  };
  return (
    <View style={[styles.card, styles.cardPending]}>
      <Text style={styles.cardLabel}>{item.source}</Text>
      <Text style={styles.cardTitle}>{item.message}</Text>
      {item.fields.map(field)}
      <View style={styles.buttons}>
        <Button
          label="Send"
          primary
          onPress={() =>
            onInput(item.requestId, {
              action: "accept",
              values: Object.fromEntries(
                Object.entries(values).filter(([, v]) => v !== ""),
              ),
            })
          }
        />
        <Button
          label="Dismiss"
          onPress={() =>
            onInput(item.requestId, { action: "decline", values: {} })
          }
        />
      </View>
    </View>
  );
}

/** A secret the agent asked for: typed here, never shown in the conversation. */
function SecretCard({
  item,
  onSecret,
}: {
  item: Extract<TranscriptItem, { kind: "secret" }>;
  onSecret: (requestId: string, value: string | null) => void;
}) {
  const [value, setValue] = useState("");
  if (item.outcome !== null) {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Secret: {item.label}</Text>
        <Text style={styles.resolved}>
          {item.outcome === "provided"
            ? "Provided"
            : item.outcome === "declined"
              ? "Declined"
              : "Expired"}
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.card, styles.cardPending]}>
      <Text style={styles.cardTitle}>🔑 {item.label}</Text>
      {item.reason ? <Text style={styles.cardText}>{item.reason}</Text> : null}
      <TextInput
        style={styles.input}
        secureTextEntry
        value={value}
        onChangeText={setValue}
        placeholder={item.placeholder ?? "Paste or type the secret"}
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={styles.buttons}>
        <Button
          label="Provide"
          primary
          onPress={() => value && onSecret(item.requestId, value)}
        />
        <Button
          label="Decline"
          onPress={() => onSecret(item.requestId, null)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  back: { color: colors.accent, fontSize: 16 },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
  headerMeta: { color: colors.faint, fontSize: 12 },
  transcript: { padding: 16, gap: 10 },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    backgroundColor: colors.bubble,
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  userText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  systemCard: {
    backgroundColor: colors.panelSoft,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    gap: 3,
  },
  systemLabel: { color: colors.faint, fontSize: 11, fontWeight: "600" },
  systemText: { color: colors.muted, fontSize: 13 },
  activity: { color: colors.faint, fontSize: 12 },
  rowCenter: { flexDirection: "row", alignItems: "center", gap: 6 },
  chevron: { color: colors.faint, fontSize: 11, width: 10 },
  expanded: {
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    paddingLeft: 10,
    marginLeft: 4,
  },
  toolOutput: {
    backgroundColor: "#000",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: 260,
    marginLeft: 16,
  },
  toolOutputText: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 11.5,
    lineHeight: 16,
    color: colors.muted,
  },
  activityDetail: { color: "#52525b" },
  notice: { color: colors.faint, fontSize: 12, fontStyle: "italic" },
  working: { flexDirection: "row", alignItems: "center", gap: 8 },
  workingText: { color: colors.muted, fontSize: 13 },
  card: {
    backgroundColor: colors.panelSoft,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 8,
  },
  cardPending: { borderColor: "rgba(251,191,36,0.45)" },
  cardLabel: { color: colors.faint, fontSize: 11, fontWeight: "600" },
  cardTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  cardText: { color: colors.muted, fontSize: 13 },
  code: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color: colors.textSoft,
    fontSize: 12,
    backgroundColor: "#000",
    padding: 8,
    borderRadius: 8,
  },
  buttons: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  button: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  buttonPrimary: { backgroundColor: colors.text, borderColor: colors.text },
  buttonText: { color: colors.textSoft, fontWeight: "600", fontSize: 13 },
  buttonTextPrimary: { color: colors.bg },
  resolved: { color: colors.faint, fontSize: 12 },
  fieldTitle: { color: colors.textSoft, fontSize: 13 },
  option: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
  },
  optionOn: {
    borderColor: colors.accent,
    backgroundColor: "rgba(129,140,248,0.12)",
  },
  optionLabel: { color: colors.text, fontSize: 14, fontWeight: "500" },
  optionDetail: { color: colors.faint, fontSize: 12, marginTop: 2 },
  error: { color: colors.red, fontSize: 13, paddingHorizontal: 16 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    color: colors.text,
    backgroundColor: colors.panel,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
    fontSize: 15,
    maxHeight: 140,
  },
  sendButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { color: colors.bg, fontSize: 20, fontWeight: "700" },
  stop: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stopText: { color: colors.textSoft, fontSize: 14 },
  disabled: { opacity: 0.35 },
});
