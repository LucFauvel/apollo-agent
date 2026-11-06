import {
  reduceTranscript,
  showWorking,
  systemMessageParts,
  toBlocks,
  type TranscriptBlock,
  type TranscriptItem,
  type TranscriptState,
} from "@apollo/client";
import type { InputField, InputValue, SessionId } from "@apollo/contracts";
import {
  type ReactNode,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Animated,
  Linking,
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
import { ActivityGroup } from "../Activity.tsx";
import { animateLayout, FadeIn, Pulse, ScrollHold, Spin, Turn, useKeyboardInset, useToggle } from "../motion.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { errorMessage } from "../connection.ts";
import { colors } from "../theme.ts";
import { ConversationBar, ConversationToggle, MicButton, useVoiceConversation, useVoiceStatus } from "../VoiceChat.tsx";
import {
  ArrowUpIcon,
  BanIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  ClipboardListIcon,
  InfoIcon,
  KeyRoundIcon,
  LoaderIcon,
  LockIcon,
  NetworkIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SpeakerIcon,
  SquareIcon,
} from "../icons.tsx";
import { speak, stopSpeaking } from "../voice.ts";
import { speakable } from "@apollo/client";

type Action =
  | { type: "event"; event: Parameters<typeof reduceTranscript>[1] }
  | { type: "reset"; sessionId: SessionId };
const reducer = (state: TranscriptState, action: Action): TranscriptState =>
  action.type === "reset"
    ? { sessionId: action.sessionId, lastSeq: 0, items: [] }
    : reduceTranscript(state, action.event);

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
  const busy = working || session?.status === "waiting-approval";
  const act = (f: Parameters<typeof connection.rpc>[0]) => {
    setError(null);
    connection.rpc(f).catch((e) => setError(errorMessage(e)));
  };
  // Sent messages show at once; each is dropped when the server's copy arrives.
  const [outbox, setOutbox] = useState<Array<{ id: number; text: string }>>([]);
  const outboxId = useRef(0);
  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    setError(null);
    const id = ++outboxId.current;
    setOutbox((o) => [...o, { id, text: value }]);
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
    connection
      .rpc((c) => c["sessions.send"]({ sessionId, text: value }))
      .catch((e) => {
        setOutbox((o) => o.filter((m) => m.id !== id));
        setError(errorMessage(e));
        setText(value);
      });
  };

  const items = transcript.items;
  const blocks = useMemo(() => toBlocks(items), [items]);
  // Hands-free voice conversation with this session.
  const [talking, setTalking] = useState(false);
  useVoiceConversation({
    active: talking,
    sessionId,
    session,
    items,
    connection,
    onError: (message) => {
      setError(message);
      setTalking(false);
    },
  });
  // The server's copy of a sent message replaces the one shown right away.
  const userTexts = useMemo(
    () => items.filter((i): i is Extract<TranscriptItem, { kind: "user" }> => i.kind === "user").map((i) => i.text),
    [items],
  );
  const seenUserCount = useRef(0);
  useEffect(() => {
    const fresh = userTexts.slice(seenUserCount.current);
    seenUserCount.current = userTexts.length;
    if (fresh.length === 0) return;
    setOutbox((o) => {
      const left = [...o];
      for (const text of fresh) {
        const i = left.findIndex((m) => m.text.trim() === text.trim());
        if (i >= 0) left.splice(i, 1);
      }
      return left;
    });
  }, [userTexts]);
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
        <ConversationToggle active={talking} onToggle={() => setTalking((t) => !t)} />
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
          {blocks.map((item, i) => (
            <FadeIn
              key={item.key}
              animate={Date.now() - openedAt.current > 1000}
            >
              <Item
                item={item}
                live={busy && i === blocks.length - 1}
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
        {outbox.map((m) => (
          <FadeIn key={`outbox-${m.id}`}>
            <View style={[styles.userBubble, styles.sending]}>
              <Text style={styles.userText}>{m.text}</Text>
            </View>
          </FadeIn>
        ))}
        {outbox.length > 0 || showWorking(busy, session?.status === "waiting-approval", blocks.at(-1)) ? (
          <View style={styles.working}>
            <Spin>
              <LoaderIcon size={14} color={colors.faint} />
            </Spin>
            <Pulse>
              <Text style={styles.workingText}>Working…</Text>
            </Pulse>
          </View>
        ) : null}
      </ScrollView>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {talking ? <ConversationBar session={session} onEnd={() => setTalking(false)} /> : null}
      <View style={styles.composer}>
        <MicButton
          disabled={talking}
          onError={setError}
          onText={(spoken) => setText((current) => (current.trim() ? `${current.trimEnd()} ${spoken}` : spoken))}
        />
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
            <SquareIcon size={14} color={colors.textSoft} />
          </Pressable>
        ) : null}
        <Pressable
          style={[styles.sendButton, !text.trim() && styles.disabled]}
          onPress={send}
          disabled={!text.trim()}
        >
          <ArrowUpIcon size={18} strokeWidth={2.5} color={colors.bg} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

type Respond = {
  onApprove: (requestId: string, decision: "accept" | "accept-for-session" | "decline") => void;
  onInput: (requestId: string, response: { action: "accept" | "decline"; values: Record<string, InputValue> }) => void;
  onSecret: (requestId: string, value: string | null) => void;
};

/** One block of the conversation, drawn as the desktop app draws it (apps/web SessionView.tsx). */
function Item({ item, live, onApprove, onInput, onSecret }: { item: TranscriptBlock; live: boolean } & Respond) {
  switch (item.kind) {
    case "activity":
      return <ActivityGroup block={item} live={live} />;
    case "user":
      return item.author === "user" ? (
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{item.text}</Text>
        </View>
      ) : (
        <SystemMessage author={item.author} text={item.text} />
      );
    case "assistant":
      // A scheduled run or heartbeat with nothing to report.
      if (!item.streaming && item.text.trim() === "[SILENT]") return <Text style={styles.silent}>Nothing to report.</Text>;
      return (
        <View>
          <Markdown text={item.text} />
          {item.streaming ? <Pulse style={styles.cursor}>{null}</Pulse> : <ListenButton text={item.text} />}
        </View>
      );
    case "notice":
      return (
        <View style={styles.notice}>
          {item.level === "error" ? <CircleAlertIcon size={14} color={colors.red} /> : <InfoIcon size={14} color={colors.faint} />}
          <Text style={[styles.noticeText, item.level === "error" && { color: colors.red }]}>{item.message}</Text>
        </View>
      );
    case "turn-end":
      return (
        <View style={styles.turnEnd}>
          <View style={styles.turnEndLine} />
          <Text style={[styles.turnEndText, item.outcome === "failed" && { color: colors.red }]} numberOfLines={1}>
            {item.outcome === "interrupted" ? "Stopped" : "Turn failed"}
            {item.error ? `: ${item.error}` : ""}
          </Text>
          <View style={styles.turnEndLine} />
        </View>
      );
    case "approval":
      return <ApprovalCard item={item} onApprove={onApprove} />;
    case "input":
      return <InputCard item={item} onInput={onInput} />;
    case "secret":
      return <SecretCard item={item} onSecret={onSecret} />;
    case "visual":
    case "recording":
      return (
        <View style={styles.notice}>
          <InfoIcon size={14} color={colors.faint} />
          <Text style={styles.noticeText}>{item.title}: open Apollo on your computer to view it.</Text>
        </View>
      );
    default:
      return null;
  }
}

/** A small colored label (the desktop's Badge). */
function Badge({ label, tone, icon }: { label: string; tone: "zinc" | "emerald" | "red" | "sky"; icon?: ReactNode }) {
  const t = BADGE[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg }]}>
      {icon}
      <Text style={[styles.badgeText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}
const BADGE = {
  zinc: { bg: colors.border, fg: colors.muted },
  emerald: { bg: "rgba(16,185,129,0.15)", fg: "#6ee7b7" },
  red: { bg: "rgba(239,68,68,0.15)", fg: "#fca5a5" },
  sky: { bg: "rgba(14,165,233,0.15)", fg: "#7dd3fc" },
} as const;

/**
 * A message from the orchestrator or from Apollo (worker reports, job and PR updates):
 * collapsed to its first line, with the rest rendered as markdown when opened.
 */
function SystemMessage({ author, text }: { author: string; text: string }) {
  const [open, toggle] = useToggle();
  const { first, body } = systemMessageParts(text);
  return (
    <View style={styles.systemCard}>
      <Pressable onPress={body ? toggle : undefined} style={styles.systemHeader}>
        {author === "bot" ? <NetworkIcon size={14} color={colors.faint} /> : <InfoIcon size={14} color={colors.faint} />}
        <Text style={styles.systemLabel}>{author === "bot" ? "Orchestrator" : "Apollo"}</Text>
        <Text style={styles.systemText} numberOfLines={1}>
          {first}
        </Text>
        {body ? (
          <Turn open={open} degrees={180}>
            <ChevronDownIcon size={14} color={colors.faint} />
          </Turn>
        ) : null}
      </Pressable>
      {/* Outside the tap target, so code inside can scroll sideways. */}
      {open && body ? (
        <View style={styles.systemBody}>
          <Markdown text={body} color={colors.textSoft} size={14} />
        </View>
      ) : null}
    </View>
  );
}

/** Reads a reply aloud (tap again to stop). */
function ListenButton({ text }: { text: string }) {
  const status = useVoiceStatus();
  const [mine, setMine] = useState(false);
  const speaking = mine && status.kind === "speaking";
  useEffect(() => {
    if (mine && status.kind === "idle") setMine(false);
  }, [mine, status.kind]);
  return (
    <Pressable
      hitSlop={8}
      style={styles.listen}
      onPress={() => {
        if (speaking) return void stopSpeaking();
        setMine(true);
        void stopSpeaking().then(() => speak(speakable(text)));
      }}
    >
      <SpeakerIcon size={14} color={speaking ? colors.accent : colors.faint} />
      <Text style={[styles.listenText, speaking && { color: colors.accent }]}>{speaking ? "Stop" : "Listen"}</Text>
    </Pressable>
  );
}

function Button({
  label,
  onPress,
  variant = "default",
  icon,
  disabled,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "default" | "ghost" | "danger";
  icon?: (color: string) => ReactNode;
  disabled?: boolean;
}) {
  const fg = variant === "primary" ? colors.bg : variant === "danger" ? "#fca5a5" : colors.textSoft;
  return (
    <Pressable
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && styles.buttonPrimary,
        (variant === "ghost" || variant === "danger") && styles.buttonGhost,
        pressed && { opacity: 0.6 },
        disabled && { opacity: 0.4 },
      ]}
      onPress={onPress}
    >
      {icon?.(fg)}
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

/** A tool the agent wants to run: amber while it waits for an answer. */
function ApprovalCard({ item, onApprove }: { item: Extract<TranscriptItem, { kind: "approval" }> } & Pick<Respond, "onApprove">) {
  const pending = item.decision === null;
  return (
    <View style={[styles.card, pending && styles.cardAmber]}>
      <View style={styles.cardHeader}>
        <ShieldAlertIcon size={16} strokeWidth={1.75} color={pending ? "#fcd34d" : colors.faint} />
        <Text style={[styles.cardTitle, { color: pending ? "#fef3c7" : colors.muted }]}>{item.title}</Text>
        {!pending ? (
          <Badge
            tone={item.decision === "decline" ? "red" : "emerald"}
            label={item.decision === "decline" ? "Declined" : item.decision === "accept-for-session" ? "Allowed for session" : "Allowed"}
          />
        ) : null}
      </View>
      {item.detail ? (
        <ScrollView style={styles.detail} nestedScrollEnabled contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={styles.detailText} selectable>
            {item.detail}
          </Text>
        </ScrollView>
      ) : null}
      {pending ? (
        <View style={styles.buttons}>
          <Button label="Allow" variant="primary" icon={(c) => <CheckIcon size={14} color={c} />} onPress={() => onApprove(item.requestId, "accept")} />
          <Button label="Allow for session" onPress={() => onApprove(item.requestId, "accept-for-session")} />
          <View style={{ flex: 1 }} />
          <Button label="Decline" variant="danger" icon={(c) => <BanIcon size={14} color={c} />} onPress={() => onApprove(item.requestId, "decline")} />
        </View>
      ) : null}
    </View>
  );
}

const INPUT_RESOLVED: Record<string, string> = { accept: "Submitted", decline: "Declined", cancel: "Cancelled" };

/** Questions from the agent (AskUserQuestion, MCP forms): choices as buttons, text as inputs. */
function InputCard({ item, onInput }: { item: Extract<TranscriptItem, { kind: "input" }> } & Pick<Respond, "onInput">) {
  const [values, setValues] = useState<Record<string, InputValue>>({});
  const pending = item.action === null;
  const field = (f: InputField) => {
    if (f.kind === "select" || f.kind === "multi-select") {
      const selected = values[f.name];
      return (
        <View key={f.name} style={{ gap: 6 }}>
          <FieldTitle field={f} />
          {f.options.map((o) => {
            const on = Array.isArray(selected) ? selected.includes(o.value) : selected === o.value;
            const [label, ...rest] = o.label.split(" — ");
            return (
              <Pressable
                key={o.value}
                style={[styles.option, on && styles.optionOn]}
                onPress={() =>
                  setValues((v) => {
                    if (f.kind === "select") return { ...v, [f.name]: on ? "" : o.value };
                    const list = Array.isArray(v[f.name]) ? (v[f.name] as Array<string>) : [];
                    return { ...v, [f.name]: on ? list.filter((x) => x !== o.value) : [...list, o.value] };
                  })
                }
              >
                <Text style={styles.optionLabel}>{label}</Text>
                {rest.length ? <Text style={styles.optionDetail}>{rest.join(" — ")}</Text> : null}
              </Pressable>
            );
          })}
          {f.description ? <Text style={styles.fieldDescription}>{f.description}</Text> : null}
        </View>
      );
    }
    if (f.kind === "boolean") {
      const on = values[f.name] === true;
      return (
        <Pressable key={f.name} style={[styles.option, on && styles.optionOn]} onPress={() => setValues((v) => ({ ...v, [f.name]: !on }))}>
          <Text style={styles.optionLabel}>{f.title}</Text>
        </Pressable>
      );
    }
    return (
      <View key={f.name} style={{ gap: 6 }}>
        <FieldTitle field={f} />
        <TextInput
          style={styles.fieldInput}
          secureTextEntry={f.secret}
          keyboardType={f.kind === "string" ? "default" : "numeric"}
          value={typeof values[f.name] === "string" || typeof values[f.name] === "number" ? String(values[f.name]) : ""}
          onChangeText={(t) => setValues((v) => ({ ...v, [f.name]: f.kind === "string" ? t : t === "" ? "" : Number(t) }))}
          placeholderTextColor={colors.faint}
        />
        {f.description ? <Text style={styles.fieldDescription}>{f.description}</Text> : null}
      </View>
    );
  };
  return (
    <View style={[styles.card, pending && styles.cardSky]}>
      <View style={styles.cardHeader}>
        <ClipboardListIcon size={16} strokeWidth={1.75} color={pending ? "#7dd3fc" : colors.faint} />
        <Text style={[styles.cardLabel, { color: pending ? "#bae6fd" : colors.muted }]}>{item.source} needs input</Text>
        {!pending ? <Badge tone={item.action === "accept" ? "emerald" : "zinc"} label={INPUT_RESOLVED[item.action] ?? item.action} /> : null}
      </View>
      {item.message ? <Text style={styles.cardText}>{item.message}</Text> : null}
      {item.url ? (
        <Pressable onPress={() => void Linking.openURL(item.url!)}>
          <Text style={styles.link} numberOfLines={1}>
            {item.url}
          </Text>
        </Pressable>
      ) : null}
      {pending ? (
        <>
          {item.fields.map(field)}
          <View style={styles.buttons}>
            <Button
              label={item.url ? "Done" : "Submit"}
              variant="primary"
              onPress={() =>
                onInput(item.requestId, {
                  action: "accept",
                  values: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "")),
                })
              }
            />
            <Button label="Decline" variant="ghost" onPress={() => onInput(item.requestId, { action: "decline", values: {} })} />
          </View>
        </>
      ) : null}
    </View>
  );
}

function FieldTitle({ field }: { field: InputField }) {
  return (
    <Text style={styles.fieldTitle}>
      {field.title}
      {field.required ? <Text style={{ color: "#7dd3fc" }}> *</Text> : null}
    </Text>
  );
}

/** A secret the agent asked for: typed here, never shown in the conversation. */
function SecretCard({ item, onSecret }: { item: Extract<TranscriptItem, { kind: "secret" }> } & Pick<Respond, "onSecret">) {
  const [value, setValue] = useState("");
  if (item.outcome !== null) {
    return (
      <View style={styles.secretDone}>
        <KeyRoundIcon size={14} strokeWidth={1.75} color={colors.faint} />
        <Text style={styles.secretDoneText} numberOfLines={1}>
          Secret requested: <Text style={{ color: colors.textSoft }}>{item.label}</Text>
        </Text>
        {item.outcome === "provided" ? (
          <Badge
            tone={item.source === "1password" ? "sky" : "emerald"}
            label={item.source === "1password" ? "From 1Password" : "Provided"}
            icon={item.source === "1password" ? undefined : <ShieldCheckIcon size={10} color="#6ee7b7" />}
          />
        ) : (
          <Badge tone={item.outcome === "declined" ? "red" : "zinc"} label={item.outcome === "declined" ? "Declined" : "Expired"} />
        )}
      </View>
    );
  }
  return (
    <View style={[styles.card, styles.cardAmber]}>
      <View style={[styles.cardHeader, { alignItems: "flex-start", gap: 12 }]}>
        <View style={styles.secretIcon}>
          <KeyRoundIcon size={16} strokeWidth={1.75} color="#fcd34d" />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.cardTitle, { color: "#fffbeb" }]}>{item.label}</Text>
          {item.reason ? <Text style={styles.cardMuted}>{item.reason}</Text> : null}
        </View>
      </View>
      <View style={styles.secretRow}>
        <TextInput
          style={[styles.fieldInput, { flex: 1, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 13 }]}
          secureTextEntry
          value={value}
          onChangeText={setValue}
          placeholder={item.placeholder ?? "Paste or type the secret"}
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button label="Provide" variant="primary" disabled={!value} icon={(c) => <LockIcon size={14} color={c} />} onPress={() => value && onSecret(item.requestId, value)} />
      </View>
      <View style={styles.secretFooter}>
        <Text style={styles.secretHint}>Kept out of the conversation; the agent only gets a way to use it.</Text>
        <Button label="Decline" variant="ghost" onPress={() => onSecret(item.requestId, null)} />
      </View>
    </View>
  );
}

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

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
  transcript: { padding: 16, gap: 12 },
  sending: { opacity: 0.6 },
  listen: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", marginTop: 4, paddingVertical: 3 },
  listenText: { color: colors.faint, fontSize: 11.5 },
  cursor: { width: 6, height: 14, borderRadius: 2, backgroundColor: colors.muted, marginTop: 2 },
  silent: { color: "#52525b", fontSize: 11.5, fontStyle: "italic" },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    backgroundColor: colors.bubble,
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginTop: 4,
  },
  userText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  // The orchestrator's and Apollo's messages.
  systemCard: { backgroundColor: "rgba(24,24,27,0.4)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(39,39,42,0.8)" },
  systemHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 9 },
  systemLabel: { color: colors.faint, fontSize: 11.5, fontWeight: "500" },
  systemText: { flex: 1, color: colors.textSoft, fontSize: 12.5 },
  systemBody: { borderTopWidth: 1, borderTopColor: "rgba(39,39,42,0.8)", paddingHorizontal: 14, paddingVertical: 10 },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 6, paddingHorizontal: 8 },
  noticeText: { flex: 1, color: colors.faint, fontSize: 12.5, lineHeight: 17 },
  turnEnd: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  turnEndLine: { flex: 1, height: 1, backgroundColor: colors.border },
  turnEndText: { color: colors.faint, fontSize: 11.5, maxWidth: "80%" },
  working: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 6 },
  workingText: { color: colors.muted, fontSize: 12.5 },
  // Approval, question and secret cards.
  card: {
    backgroundColor: "rgba(24,24,27,0.3)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 10,
  },
  cardAmber: { borderColor: "rgba(217,119,6,0.4)", backgroundColor: "rgba(69,26,3,0.2)" },
  cardSky: { borderColor: "rgba(3,105,161,0.4)", backgroundColor: "rgba(8,47,73,0.2)" },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardLabel: { flex: 1, fontSize: 12.5, fontWeight: "500" },
  cardTitle: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "500" },
  cardText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  cardMuted: { color: colors.muted, fontSize: 12.5, lineHeight: 18 },
  link: { color: "#7dd3fc", fontSize: 12, fontFamily: MONO, textDecorationLine: "underline" },
  detail: { maxHeight: 240, borderRadius: 8, backgroundColor: "rgba(0,0,0,0.3)" },
  detailText: { color: colors.textSoft, fontSize: 12, lineHeight: 17, fontFamily: MONO },
  badge: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { fontSize: 10.5, fontWeight: "500" },
  buttons: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  buttonPrimary: { backgroundColor: colors.text, borderColor: colors.text },
  buttonGhost: { backgroundColor: "transparent", borderColor: "transparent" },
  buttonText: { fontWeight: "500", fontSize: 13 },
  fieldTitle: { color: colors.textSoft, fontSize: 12.5, fontWeight: "500" },
  fieldDescription: { color: colors.faint, fontSize: 11.5 },
  fieldInput: {
    color: colors.text,
    backgroundColor: colors.panel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  option: { borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 10 },
  optionOn: { borderColor: "rgba(125,211,252,0.6)", backgroundColor: "rgba(14,165,233,0.12)" },
  optionLabel: { color: colors.text, fontSize: 14, fontWeight: "500" },
  optionDetail: { color: colors.faint, fontSize: 12, marginTop: 2 },
  secretDone: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(39,39,42,0.8)",
    backgroundColor: "rgba(24,24,27,0.3)",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  secretDoneText: { flex: 1, color: colors.muted, fontSize: 12.5 },
  secretIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "rgba(245,158,11,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  secretRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  secretFooter: { flexDirection: "row", alignItems: "center", gap: 8 },
  secretHint: { flex: 1, color: "#52525b", fontSize: 11 },
  // The message box.
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
  stop: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  disabled: { opacity: 0.35 },
});
