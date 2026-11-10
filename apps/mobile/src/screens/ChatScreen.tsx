import {
  cardsTick,
  currentChangesKey,
  hasCards,
  initialCards,
  latestChangesKey,
  reduceCards,
  reduceTranscript,
  replayBuffer,
  summariesByTurn,
  withoutFullDiffs,
  isCompacting,
  showWorking,
  systemMessageParts,
  toBlocks,
  type TranscriptBlock,
  type TranscriptItem,
  type TranscriptState,
} from "@apollo/client";
import { type Bot, type BotId, type InputField, type InputValue, limitsAccount, type ProjectId, type RepoChanges, type SessionId, sortBots } from "@apollo/contracts";
import {
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Animated,
  Easing,
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
import { MonitorStrip } from "../MonitorStrip.tsx";
import { ArtifactCard, RecordingCard, VisualCard } from "../PageCards.tsx";
import { ActivityGroup } from "../Activity.tsx";
import { BrowserScreen, type Handoff } from "./BrowserScreen.tsx";
import { ChangesScreen, FullDiff } from "./ChangesScreen.tsx";
import { ProjectsScreen } from "./ProjectsScreen.tsx";
import { UsageMeter } from "../UsageMeter.tsx";
import { animateLayout, FadeIn, Pulse, ScrollHold, Spin, SwipeBack, Turn, useKeyboardInset, useToggle } from "../motion.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { errorMessage } from "../connection.ts";
import { colors } from "../theme.ts";
import { ConversationBar, ConversationToggle, MicButton, useVoiceConversation, useVoiceStatus } from "../VoiceChat.tsx";
import {
  ArrowUpIcon,
  GitCompareArrowsIcon,
  BanIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  ClipboardListIcon,
  InfoIcon,
  AppWindowIcon,
  FolderKanbanIcon,
  HandIcon,
  KeyRoundIcon,
  LoaderIcon,
  LockIcon,
  NetworkIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SpeakerIcon,
  SquareIcon,
} from "../icons.tsx";
import { speak, stopSpeaking } from "../voice.ts";
import { speakable } from "@apollo/client";

type Event = Parameters<typeof reduceTranscript>[1];
type Action = { type: "events"; events: ReadonlyArray<Event> } | { type: "reset"; sessionId: SessionId };
const reducer = (state: TranscriptState, action: Action): TranscriptState =>
  action.type === "reset"
    ? { sessionId: action.sessionId, lastSeq: 0, items: [] }
    : action.events.reduce(reduceTranscript, state);

/**
 * How many of the latest blocks a conversation shows when it opens; scrolling up to the
 * top shows as many more. Rendering a long history at once (markdown, highlighted code)
 * is what froze the screen.
 */
const WINDOW = 40;

/** Longest our own animated scroll to the latest message takes (iOS and Android: ~250–300 ms). */
const OWN_SCROLL_MS = 600;

/** A conversation: its live transcript, cards that need the user, and a message box. */
export function ChatScreen({
  sessionId,
  onBack,
  onOpenSession,
  onNewSession,
}: {
  sessionId: SessionId;
  onBack: () => void;
  /** Opens another session (a worker, from the Changes screen). */
  onOpenSession: (id: SessionId) => void;
  /** Starts a new session for a bot, in one of its projects or none. */
  onNewSession: (botId: BotId, projectId?: ProjectId | null) => void;
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
  /**
   * Until when scroll events are our own scrolling to the latest message, not the user's:
   * they must not turn following off half-way (output arriving meanwhile is caught up with
   * by `onContentSizeChange`). The user dragging, or reaching the bottom, ends it early.
   */
  const ownScrollUntil = useRef(0);
  // While the user's finger is on the transcript, nothing scrolls it for them.
  const dragging = useRef(false);
  // Earlier blocks show only when the user scrolled up to them, never from our scrolling.
  const userScrolled = useRef(false);
  const viewport = useRef(0);
  const contentHeight = useRef(0);
  /**
   * Scrolls to the latest message, and follows new output from there. Every scroll of ours
   * goes through here, including deferred ones (keyboard, send): while the user's finger is
   * on the transcript it does nothing, and following stays as their scrolling left it.
   */
  const toLatest = (animated: boolean) => {
    if (dragging.current) return;
    userScrolled.current = false;
    atBottom.current = true;
    ownScrollUntil.current = Date.now() + OWN_SCROLL_MS;
    setFarFromBottom(false);
    scroll.current?.scrollToEnd({ animated });
  };
  const hold = useMemo(
    () => () => void (holdUntil.current = Date.now() + 700),
    [],
  );
  /**
   * The history replayed when the conversation opens is loaded in batches, under a
   * spinner, with the transcript hidden until it sits at the latest message: it appears
   * there, without scrolling down to it. Rows already there appear at once; later ones fade in.
   */
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const reveal = useRef(new Animated.Value(0)).current;
  /**
   * The window's first block, by key (see WINDOW), fixed once loaded. A key, not an index:
   * a `/clear` empties the transcript, and the next messages must not inherit an old
   * position. null, or a key no longer there: the latest WINDOW blocks (pinned again by
   * the effect below as soon as there is a block).
   */
  const [firstKey, setFirstKey] = useState<string | null>(null);
  /**
   * Two cursors. `received`: the last event handed to the replay buffer (skips repeats).
   * `applied`: the last one in the transcript, where a new stream resumes: events still
   * in the buffer when it is disposed (the connection replaced) are fetched again.
   */
  const received = useRef(0);
  const applied = useRef(0);
  // Lift the conversation and the message box above the keyboard, and show the latest message.
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset(insets.bottom, () => setTimeout(() => toLatest(true), 50));

  // A button back to the latest message, once scrolled up a good way from it.
  const [farFromBottom, setFarFromBottom] = useState(false);
  const jumpShown = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(jumpShown, { toValue: farFromBottom ? 1 : 0, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [farFromBottom, jumpShown]);
  const jumpToBottom = () => toLatest(true);

  useEffect(() => {
    dispatch({ type: "reset", sessionId });
    received.current = 0;
    applied.current = 0;
    atBottom.current = true;
    userScrolled.current = false;
    loadedRef.current = false;
    setLoaded(false);
    setFirstKey(null);
    reveal.setValue(0);
    setFarFromBottom(false);
  }, [sessionId, reveal]);

  // A conversation with nothing in it yet answers with no event at all: do not wait long.
  const looksEmpty = session ? session.completedTurns === 0 && !session.lastMessage : false;
  const looksEmptyRef = useRef(looksEmpty);
  looksEmptyRef.current = looksEmpty;
  // Resumes after the last event seen, so a reconnect does not reload the conversation.
  useEffect(() => {
    // What this buffer still holds is not applied: a new stream starts after `applied`.
    received.current = applied.current;
    const buffer = replayBuffer<Event>({
      onBatch: (events) => {
        applied.current = Math.max(applied.current, events.at(-1)!.seq);
        dispatch({ type: "events", events });
      },
      onCaughtUp: () => {
        loadedRef.current = true;
        setLoaded(true);
      },
      timing: looksEmptyRef.current ? { emptyMs: 300 } : {},
    });
    const stop = connection.follow(
      (client) => client["sessions.events"]({ sessionId, afterSeq: applied.current }),
      (event) => {
        if (event.seq <= received.current) return;
        received.current = event.seq;
        buffer.push(event);
      },
    );
    return () => {
      stop();
      buffer.dispose();
    };
  }, [connection, sessionId]);

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
    setTimeout(() => toLatest(true), 50);
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
  const latestStart = Math.max(0, blocks.length - WINDOW);
  const pinnedAt = useMemo(() => (firstKey === null ? -1 : blocks.findIndex((b) => b.key === firstKey)), [blocks, firstKey]);
  const start = pinnedAt >= 0 ? pinnedAt : latestStart;
  const shown = useMemo(() => (start === 0 ? blocks : blocks.slice(start)), [blocks, start]);
  const showEarlier = () => setFirstKey(blocks[Math.max(0, start - WINDOW)]?.key ?? null);
  // Once loaded, the window stays where it starts (new blocks add to it), from its first
  // block on: also after a `/clear`, and for history arriving only after an empty wait.
  const pinKey = pinnedAt < 0 ? (blocks[latestStart]?.key ?? null) : null;
  useEffect(() => {
    if (loaded && pinKey !== null) setFirstKey(pinKey);
  }, [loaded, pinKey]);
  // Loaded: sit at the latest message, then show it all.
  useEffect(() => {
    if (!loaded) return;
    toLatest(false);
    const frame = requestAnimationFrame(() =>
      Animated.timing(reveal, { toValue: 1, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(),
    );
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  // Compaction can take minutes on a local model: say so instead of "Working…".
  const compacting = useMemo(() => isCompacting(items), [items]);
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
    if (count && loadedRef.current) animateLayout(180);
  }, [count]);

  // `@Name` asks another bot: suggest bots while a tag is being typed at the end.
  const mentionQuery = /(?:^|\s)@([^\s@]*)$/.exec(text)?.[1];
  const mentionMatches =
    mentionQuery === undefined || !session
      ? []
      : sortBots(state.bots.values()).filter((b) => b.id !== session.botId && b.name.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 6);
  // The Changes screen, over the conversation (swipe from the edge to come back).
  const [changesOpen, setChangesOpen] = useState(false);
  const openPullRequests = useMemo(() => {
    if (!session) return 0;
    const ids = new Set(session.role === "main" ? [...state.sessions.values()].filter((s) => s.botId === session.botId).map((s) => s.id) : [session.id]);
    const urls = new Set<string>();
    for (const pr of state.pullRequests.values()) if (ids.has(pr.sessionId) && (pr.state === "open" || pr.state === "draft")) urls.add(pr.url);
    return urls.size;
  }, [state.pullRequests, state.sessions, session]);
  const hasChanges = useMemo(() => items.some((item) => item.kind === "changes" && !item.report), [items]);
  // Full diffs are not a turn's changes card: they neither fold history nor take its place.
  const turnItems = useMemo(() => withoutFullDiffs(items), [items]);
  const anyCards = useMemo(() => hasCards(turnItems), [turnItems]);
  // Each turn's changes card shows its worker's summary.
  // Bumped by the server's ChangesUpdated, and by every reconnect (AppState.tsx).
  const changesVersion = session ? (state.changesVersion.get(session.botId) ?? 0) : 0;
  const [cardsState, dispatchCards] = useReducer(reduceCards, sessionId, initialCards);
  useEffect(() => dispatchCards({ type: "reset", sessionId }), [sessionId]);
  useEffect(() => {
    if (!anyCards) return;
    const id = sessionId;
    // Issuing it makes every earlier answer for this view stale, whatever started either.
    const fetchId = cardsTick();
    dispatchCards({ type: "fetching", sessionId: id, fetchId });
    connection
      .rpc((c) => c["changes.conversation"]({ sessionId: id }))
      .then((changes) => dispatchCards({ type: "fetched", sessionId: id, fetchId, changes }))
      .catch(() => {}); // the cards still show, without summaries
  }, [connection, sessionId, changesVersion, anyCards]);
  const cards = useMemo<ChangesCards>(() => {
    const own = cardsState.sessionId === sessionId ? cardsState : initialCards(sessionId);
    return {
      current: currentChangesKey(turnItems),
      generation: latestChangesKey(turnItems),
      summaries: summariesByTurn(own.server),
    };
  }, [turnItems, cardsState, sessionId]);
  const project = session?.projectId ? state.projects.get(session.projectId) : undefined;
  const limits = session && bot ? state.accountLimits.get(limitsAccount(session.provider, bot)) : undefined;
  // The bot's projects, from the header or the session's own project.
  const [projectsOpen, setProjectsOpen] = useState<{ focus: ProjectId | null } | null>(null);
  // Apollo's browser, live: opened from the header, or from a tab an agent handed over.
  const [browser, setBrowser] = useState<{ tabId?: string; handoff?: Handoff } | null>(null);
  const browserTabs = useMemo(() => {
    let n = 0;
    for (const tab of state.browserTabs.values()) if (tab.botId === session?.botId) n++;
    return n;
  }, [state.browserTabs, session?.botId]);

  return (
    <View style={{ flex: 1 }}>
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
          <View style={styles.headerMetaRow}>
            {project ? (
              <Pressable
                onPress={() => setProjectsOpen({ focus: project.id })}
                hitSlop={6}
                accessibilityLabel={`Project ${project.name}`}
                style={({ pressed }) => [styles.projectLink, pressed && { opacity: 0.6 }]}
              >
                <FolderKanbanIcon size={11} color={colors.muted} />
                <Text style={styles.projectLinkText} numberOfLines={1}>
                  {project.name}
                </Text>
              </Pressable>
            ) : null}
            <Text style={styles.headerMeta} numberOfLines={1}>
              {session?.status === "waiting-approval"
                ? "Needs you"
                : working
                  ? compacting
                    ? "Compacting…"
                    : "Working…"
                  : (session?.provider ?? "")}
            </Text>
            {limits && limits.meters.length > 0 && session ? <UsageMeter limits={limits} provider={session.provider} /> : null}
          </View>
        </View>
        {browserTabs > 0 ? (
          <Pressable
            onPress={() => setBrowser({})}
            hitSlop={8}
            accessibilityLabel={`Browser, ${browserTabs} open ${browserTabs === 1 ? "tab" : "tabs"}`}
            style={({ pressed }) => [styles.headerButton, pressed && { opacity: 0.6 }]}
          >
            <AppWindowIcon size={19} color={colors.muted} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => setProjectsOpen({ focus: null })}
          hitSlop={8}
          accessibilityLabel="Projects"
          style={({ pressed }) => [styles.headerButton, pressed && { opacity: 0.6 }]}
        >
          <FolderKanbanIcon size={19} color={colors.muted} />
        </Pressable>
        <Pressable
          onPress={() => setChangesOpen(true)}
          hitSlop={8}
          accessibilityLabel={openPullRequests > 0 ? `Changes and pull requests, ${openPullRequests} open` : "Changes and pull requests"}
          style={({ pressed }) => [styles.headerButton, pressed && { opacity: 0.6 }]}
        >
          <GitCompareArrowsIcon size={19} color={colors.muted} />
          {openPullRequests > 0 ? (
            <View style={styles.prBadge}>
              <Text style={styles.badgeCount}>{openPullRequests}</Text>
            </View>
          ) : hasChanges ? (
            <View style={styles.changesDot} />
          ) : null}
        </Pressable>
        <ConversationToggle active={talking} onToggle={() => setTalking((t) => !t)} />
      </View>

      <View style={{ flex: 1 }}>
      <Animated.View
        style={{ flex: 1, opacity: reveal }}
        pointerEvents={loaded ? "auto" : "none"}
        importantForAccessibility={loaded ? "auto" : "no-hide-descendants"}
        accessibilityElementsHidden={!loaded}
      >
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={styles.transcript}
        // Showing earlier blocks above keeps what is on screen where it is: anchored on the
        // first block in view (index 0 is the header slot below, always there).
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        scrollEventThrottle={64}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => {
          // The user takes over from any scrolling of ours.
          dragging.current = true;
          userScrolled.current = true;
          ownScrollUntil.current = 0;
        }}
        onScrollEndDrag={() => {
          dragging.current = false;
        }}
        onScroll={({ nativeEvent: e }) => {
          const fromBottom = e.contentSize.height - (e.contentOffset.y + e.layoutMeasurement.height);
          // Still loading: hidden, held at the latest message (see onContentSizeChange).
          if (!loadedRef.current) return;
          if (Date.now() < ownScrollUntil.current) {
            // On its way down: still following. Arrived: later events are the user's again.
            if (fromBottom <= 120) ownScrollUntil.current = 0;
            return;
          }
          atBottom.current = fromBottom <= 120;
          // Half a screen up (at least a few lines): far enough to want a way back.
          const far = fromBottom > Math.max(240, e.layoutMeasurement.height / 2);
          setFarFromBottom((was) => (was === far ? was : far));
          // Near the top after the user scrolled up: show earlier blocks (same target per render).
          if (userScrolled.current && start > 0 && e.contentOffset.y < 400) showEarlier();
        }}
        onLayout={(e) => {
          viewport.current = e.nativeEvent.layout.height;
        }}
        onContentSizeChange={(_, height) => {
          // More than a screen at once (history arriving late): jump, not a long scroll down.
          const burst = height - contentHeight.current > viewport.current;
          contentHeight.current = height;
          if (!loadedRef.current) toLatest(false);
          else if (atBottom.current && !dragging.current && Date.now() > holdUntil.current) toLatest(!burst);
        }}
      >
        {/* A real native view (never flattened), and no extra gap while empty. */}
        <View collapsable={false} style={start > 0 ? undefined : styles.noEarlier}>
          {start > 0 ? (
            <Pressable onPress={showEarlier} hitSlop={8} accessibilityRole="button" style={styles.earlier}>
              <Text style={styles.earlierText}>Show earlier messages</Text>
            </Pressable>
          ) : null}
        </View>
        <ScrollHold.Provider value={hold}>
          {shown.map((item, i) => (
            <FadeIn key={item.key} animate={loadedRef.current}>
              <Item
                item={item}
                sessionId={sessionId}
                live={busy && start + i === blocks.length - 1}
                onOpenChanges={() => setChangesOpen(true)}
                cards={cards}
                onOpenBrowser={(tabId, handoff) => setBrowser({ tabId, ...(handoff ? { handoff: { ...handoff, sessionId } } : {}) })}
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
        {compacting || outbox.length > 0 || showWorking(busy, session?.status === "waiting-approval", blocks.at(-1)) ? (
          <View style={styles.working}>
            <Spin>
              <LoaderIcon size={14} color={colors.faint} />
            </Spin>
            <Pulse>
              <Text style={styles.workingText}>{compacting ? "Compacting the conversation…" : "Working…"}</Text>
            </Pulse>
          </View>
        ) : null}
      </ScrollView>
      </Animated.View>
        {!loaded ? (
          <View style={styles.loading} pointerEvents="none">
            <Spin>
              <LoaderIcon size={14} color={colors.faint} />
            </Spin>
            <Pulse>
              <Text style={styles.workingText}>Loading the conversation…</Text>
            </Pulse>
          </View>
        ) : null}
        <Animated.View
          pointerEvents={farFromBottom ? "box-none" : "none"}
          style={[
            styles.jump,
            { opacity: jumpShown, transform: [{ translateY: jumpShown.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] },
          ]}
        >
          <Pressable
            onPress={jumpToBottom}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Scroll to the latest message"
            style={({ pressed }) => [styles.jumpButton, pressed && { opacity: 0.6 }]}
          >
            <ChevronDownIcon size={18} color={colors.textSoft} />
          </Pressable>
        </Animated.View>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {talking ? <ConversationBar session={session} onEnd={() => setTalking(false)} /> : null}
      <MonitorStrip sessionId={sessionId} />
      {mentionMatches.length > 0 ? (
        // Like Discord: a list above the composer, the best match first.
        <FadeIn>
          <View style={styles.mentions}>
            <Text style={styles.mentionsHeader} numberOfLines={1}>
              {mentionQuery ? `Bots matching @${mentionQuery}` : "Bots"}
            </Text>
            {mentionMatches.map((b, i) => (
              <Pressable
                key={b.id}
                onPress={() => setText((t) => t.replace(/@([^\s@]*)$/, `@${b.name} `))}
                style={({ pressed }) => [styles.mentionRow, (pressed || i === 0) && styles.mentionRowActive]}
              >
                <BlobAvatar avatar={b.avatar} size={30} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.mentionName} numberOfLines={1}>
                    <Text style={{ color: colors.text }}>{b.name.slice(0, mentionQuery?.length ?? 0)}</Text>
                    {b.name.slice(mentionQuery?.length ?? 0)}
                  </Text>
                  <Text style={styles.mentionDetail} numberOfLines={1}>
                    {b.instructions.trim().split("\n")[0] || "Another of your bots"}
                  </Text>
                </View>
                <Text style={styles.mentionHandle}>@{b.name.toLowerCase()}</Text>
              </Pressable>
            ))}
          </View>
        </FadeIn>
      ) : null}
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
      {browser && session ? (
        <View style={StyleSheet.absoluteFill}>
          <SwipeBack onBack={() => setBrowser(null)}>
            {(back) => <BrowserScreen botId={session.botId} tabId={browser.tabId} handoff={browser.handoff} onBack={back} />}
          </SwipeBack>
        </View>
      ) : null}
      {projectsOpen && session ? (
        <View style={StyleSheet.absoluteFill}>
          <SwipeBack onBack={() => setProjectsOpen(null)}>
            {(back) => (
              <ProjectsScreen
                botId={session.botId}
                focus={projectsOpen.focus}
                onBack={back}
                onOpenSession={(id) => (id === sessionId ? back() : onOpenSession(id))}
                onNewSession={onNewSession}
              />
            )}
          </SwipeBack>
        </View>
      ) : null}
      {changesOpen && session ? (
        <View style={StyleSheet.absoluteFill}>
          <SwipeBack onBack={() => setChangesOpen(false)}>
            {(back) => (
              <ChangesScreen
                session={session}
                onBack={back}
                onOpenSession={(id) => {
                  // This conversation's own section: just go back to it.
                  if (id === sessionId) return back();
                  setChangesOpen(false);
                  onOpenSession(id);
                }}
              />
            )}
          </SwipeBack>
        </View>
      ) : null}
    </View>
  );
}

type Respond = {
  onApprove: (requestId: string, decision: "accept" | "accept-for-session" | "decline") => void;
  onInput: (requestId: string, response: { action: "accept" | "decline"; values: Record<string, InputValue> }) => void;
  onSecret: (requestId: string, value: string | null) => void;
};

/** One block of the conversation, drawn as the desktop app draws it (apps/web SessionView.tsx). */
function Item({
  item,
  sessionId,
  live,
  onApprove,
  onInput,
  onSecret,
  onOpenChanges,
  cards,
  onOpenBrowser,
}: {
  item: TranscriptBlock;
  sessionId: SessionId;
  live: boolean;
  onOpenChanges: () => void;
  cards: ChangesCards;
  onOpenBrowser: (tabId: string, handoff?: { requestId: string; reason: string }) => void;
} & Respond) {
  switch (item.kind) {
    case "changes":
      if (item.report && item.repos[0]) {
        return <FullDiff sessionId={sessionId} seq={item.seq} repo={item.repos[0]} report={item.report} />;
      }
      return (
        <TurnChanges
          repos={item.repos}
          summary={item.turnSeq === null ? null : (cards.summaries.get(item.turnSeq) ?? null)}
          current={cards.current === item.key}
          generation={cards.generation}
          onOpen={onOpenChanges}
        />
      );
    case "activity":
      return <ActivityGroup block={item} live={live} />;
    case "user":
      return item.author === "user" ? (
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{item.text}</Text>
        </View>
      ) : item.author === "peer" ? (
        <PeerMessage botId={item.fromBotId} text={item.text} />
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
    case "handoff":
      return <HandoffCard item={item} onOpen={() => onOpenBrowser(item.tabId, item.outcome === null ? { requestId: item.requestId, reason: item.reason } : undefined)} />;
    case "visual":
      return item.artifact ? <ArtifactCard item={item} artifact={item.artifact} /> : <VisualCard item={item} />;
    case "recording":
      return <RecordingCard item={item} />;
    default:
      return null;
  }
}

/** A message from another of the user's bots: collapsed to its first line, opened on tap. */
function PeerMessage({ botId, text }: { botId: string | undefined; text: string }) {
  const { state } = useApollo();
  const bot = botId ? state.bots.get(botId as Bot["id"]) : undefined;
  const [open, toggle] = useToggle();
  const first = text.trim().split("\n").find((l) => l.trim())?.replace(/^[#*>\-\s]+/, "") ?? "";
  return (
    <View style={styles.peerCard}>
      <Pressable onPress={toggle} style={styles.peerHeader}>
        {bot ? <BlobAvatar avatar={bot.avatar} size={20} /> : null}
        <Text style={styles.peerName}>{bot?.name ?? "Another bot"}</Text>
        <Text style={styles.peerFirst} numberOfLines={1}>
          {open ? "" : first}
        </Text>
        <Turn open={open} degrees={180}>
          <ChevronDownIcon size={14} color={colors.faint} />
        </Turn>
      </Pressable>
      {/* Outside the tap target, so code inside can scroll sideways. */}
      {open ? (
        <View style={styles.peerBody}>
          <Markdown text={text} size={14.5} />
        </View>
      ) : null}
    </View>
  );
}

/** What the conversation's changes cards need besides the item (see apps/web SessionView.tsx). */
interface ChangesCards {
  /** The latest turn's card: open without interaction. */
  readonly current: string | null;
  /** The latest card: when a new one arrives, cards opened by hand fold again. */
  readonly generation: string | null;
  readonly summaries: ReadonlyMap<number, string>;
}

/**
 * What a turn changed in git repositories (detected by Apollo). The latest turn's card is
 * open (the worker's summary and the files); earlier ones fold to one line. Tapping it
 * toggles; "Review" opens the Changes screen (where changes are cleared).
 */
function TurnChanges({
  repos,
  summary,
  current,
  generation,
  onOpen,
}: {
  repos: ReadonlyArray<RepoChanges>;
  summary: string | null;
  current: boolean;
  generation: string | null;
  onOpen: () => void;
}) {
  // Opened or folded by hand until a newer turn's card arrives; then history folds again.
  const [toggled, setToggled] = useState<boolean | null>(null);
  useEffect(() => setToggled(null), [generation]);
  const open = toggled ?? current;
  // Opening a card by hand must not scroll the conversation to the end.
  const hold = useContext(ScrollHold);
  const files = repos.flatMap((r) => r.files.map((f) => ({ ...f, repo: r.name })));
  const additions = files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const dot = { added: "#34d399", modified: "#fbbf24", deleted: "#f87171", renamed: "#38bdf8" } as const;
  const shown = files.slice(0, 12);
  return (
    <View style={styles.turnChanges}>
      <View style={styles.turnChangesHead}>
        <Pressable
          onPress={() => {
            hold();
            animateLayout();
            setToggled(!open);
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          style={({ pressed }) => [styles.turnChangesToggle, pressed && { opacity: 0.6 }]}
        >
          <GitCompareArrowsIcon size={15} color={colors.faint} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.turnChangesTitle} numberOfLines={1}>
              Changed {files.length} {files.length === 1 ? "file" : "files"}
              <Text style={{ color: colors.faint }}> in {repos.map((r) => r.name).join(", ")}</Text>
            </Text>
            <View style={styles.turnChangesMeta}>
              {!open ? (
                <View style={{ flexDirection: "row", gap: 3 }}>
                  {files.slice(0, 14).map((f) => (
                    <View key={`${f.repo}/${f.path}`} style={[styles.fileDot, { backgroundColor: dot[f.status] }]} />
                  ))}
                </View>
              ) : null}
              <Text style={styles.turnChangesCounts}>
                <Text style={{ color: "#34d399" }}>+{additions}</Text> <Text style={{ color: "#f87171" }}>−{deletions}</Text>
              </Text>
              {!open && summary ? <SparklesIcon size={11} color="rgba(196,181,253,0.8)" /> : null}
            </View>
          </View>
          <Turn open={open} degrees={180}>
            <ChevronDownIcon size={15} color={colors.faint} />
          </Turn>
        </Pressable>
        <Pressable onPress={onOpen} hitSlop={8} style={({ pressed }) => [styles.turnChangesAction, pressed && { opacity: 0.6 }]}>
          <Text style={styles.turnChangesReview}>Review ›</Text>
        </Pressable>
      </View>
      {open ? (
        <View style={styles.turnChangesBody}>
          {summary ? (
            <View style={styles.turnChangesSummary}>
              <SparklesIcon size={12} color="rgba(196,181,253,0.9)" />
              <Text style={styles.turnChangesSummaryText}>{summary}</Text>
            </View>
          ) : null}
          {shown.map((f) => {
            const slash = f.path.lastIndexOf("/");
            return (
              <View key={`${f.repo}/${f.path}`} style={styles.turnChangesFile}>
                <View style={[styles.fileDot, { backgroundColor: dot[f.status] }]} />
                <Text style={styles.turnChangesPath} numberOfLines={1} ellipsizeMode="head">
                  {repos.length > 1 ? <Text style={{ color: "#52525b" }}>{f.repo}/</Text> : null}
                  <Text style={{ color: colors.faint }}>{f.path.slice(0, slash + 1)}</Text>
                  <Text style={[{ color: colors.textSoft }, f.status === "deleted" && { textDecorationLine: "line-through" }]}>{f.path.slice(slash + 1)}</Text>
                </Text>
                <Text style={styles.turnChangesCounts}>
                  {f.additions === null ? (
                    <Text style={{ color: colors.faint }}>binary</Text>
                  ) : (
                    <>
                      <Text style={{ color: "#34d399" }}>+{f.additions}</Text> <Text style={{ color: "#f87171" }}>−{f.deletions ?? 0}</Text>
                    </>
                  )}
                </Text>
              </View>
            );
          })}
          {files.length > shown.length ? <Text style={styles.turnChangesMore}>and {files.length - shown.length} more</Text> : null}
        </View>
      ) : null}
    </View>
  );
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

/** The agent handed the browser over: open the tab, take over, then say Done there. */
function HandoffCard({ item, onOpen }: { item: Extract<TranscriptItem, { kind: "handoff" }>; onOpen: () => void }) {
  if (item.outcome !== null) {
    return (
      <View style={styles.secretDone}>
        <HandIcon size={14} strokeWidth={1.75} color={colors.faint} />
        <Text style={styles.secretDoneText} numberOfLines={1}>
          Browser handed over: <Text style={{ color: colors.textSoft }}>{item.reason}</Text>
        </Text>
        <Badge
          tone={item.outcome === "done" ? "emerald" : item.outcome === "cancelled" ? "red" : "zinc"}
          label={item.outcome === "done" ? "Done" : item.outcome === "cancelled" ? "Declined" : "Expired"}
        />
      </View>
    );
  }
  let host = item.url;
  try {
    host = new URL(item.url).host || item.url;
  } catch {
    // keep the raw URL
  }
  return (
    <View style={[styles.card, styles.cardSky]}>
      <View style={[styles.cardHeader, { alignItems: "flex-start", gap: 12 }]}>
        <View style={styles.handoffIcon}>
          <Pulse>
            <HandIcon size={16} strokeWidth={1.75} color="#7dd3fc" />
          </Pulse>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.cardTitle, { color: "#f0f9ff" }]}>Your turn in the browser</Text>
          <Text style={styles.cardMuted}>{item.reason}</Text>
          <Text style={[styles.secretHint, { marginTop: 2 }]} numberOfLines={1}>
            {host} · the agent waits until you are done
          </Text>
        </View>
      </View>
      <Button label="Take over" variant="primary" icon={(c) => <AppWindowIcon size={14} color={c} />} onPress={onOpen} />
    </View>
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
          // A password field gets iOS AutoFill: the key icon above the keyboard (or
          // AutoFill > Passwords in the edit menu, iOS 18+) opens the AutoFill
          // provider (1Password, Keychain) to search and pick any item. The value
          // arrives through onChangeText like typed text. The app has no associated
          // domains, so no automatic save is expected from iOS itself; a third-party
          // provider (e.g. 1Password's Always Allow) may still offer to save or link
          // the item.
          textContentType="password"
          autoComplete="current-password"
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
  headerButton: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  prBadge: {
    position: "absolute",
    top: 1,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: "#10b981",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.bg,
  },
  badgeCount: { color: "#fff", fontSize: 9, fontWeight: "700" },
  changesDot: { position: "absolute", top: 6, right: 6, width: 7, height: 7, borderRadius: 4, backgroundColor: "#fbbf24", borderWidth: 1.5, borderColor: colors.bg },
  peerCard: { borderRadius: 12, borderWidth: 1, borderColor: "rgba(39,39,42,0.8)", backgroundColor: "rgba(24,24,27,0.4)" },
  peerHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 9 },
  peerName: { color: colors.textSoft, fontSize: 12.5, fontWeight: "600" },
  peerFirst: { flex: 1, color: colors.faint, fontSize: 12.5 },
  peerBody: { borderTopWidth: 1, borderTopColor: "rgba(39,39,42,0.8)", paddingHorizontal: 12, paddingVertical: 8 },
  mentions: {
    marginHorizontal: 10,
    marginBottom: 6,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#27272a",
    backgroundColor: "#111113",
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  mentionsHeader: {
    color: colors.faint,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 6,
  },
  mentionRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, paddingVertical: 7, borderRadius: 9 },
  mentionRowActive: { backgroundColor: "#27272a" },
  mentionName: { color: colors.textSoft, fontSize: 15, fontWeight: "600" },
  mentionDetail: { color: colors.faint, fontSize: 12, marginTop: 1 },
  mentionHandle: { color: "#52525b", fontSize: 12 },
  turnChanges: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(39,39,42,0.9)",
    backgroundColor: "rgba(24,24,27,0.35)",
    overflow: "hidden",
  },
  turnChangesHead: { flexDirection: "row", alignItems: "center", paddingRight: 4 },
  turnChangesToggle: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 12, paddingRight: 4, paddingVertical: 9 },
  turnChangesAction: { paddingHorizontal: 6, paddingVertical: 9 },
  turnChangesBody: { borderTopWidth: 1, borderTopColor: "rgba(39,39,42,0.9)", paddingHorizontal: 12, paddingVertical: 9, gap: 4 },
  turnChangesSummary: { flexDirection: "row", gap: 8, marginBottom: 4 },
  turnChangesSummaryText: { flex: 1, color: colors.textSoft, fontSize: 13, lineHeight: 19 },
  turnChangesFile: { flexDirection: "row", alignItems: "center", gap: 8 },
  turnChangesPath: { flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11.5 },
  turnChangesMore: { color: colors.faint, fontSize: 11.5, paddingLeft: 14 },
  turnChangesTitle: { color: colors.textSoft, fontSize: 13 },
  turnChangesMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  fileDot: { width: 6, height: 6, borderRadius: 3 },
  turnChangesCounts: { fontFamily: MONO, fontSize: 11 },
  turnChangesReview: { color: colors.faint, fontSize: 12 },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
  headerMeta: { color: colors.faint, fontSize: 12, flexShrink: 1 },
  headerMetaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  projectLink: { flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 1, maxWidth: "55%" },
  projectLinkText: { color: colors.muted, fontSize: 12 },
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
  loading: { ...StyleSheet.absoluteFill, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  earlier: { alignSelf: "center", paddingVertical: 6, paddingHorizontal: 12 },
  earlierText: { color: colors.faint, fontSize: 12.5 },
  noEarlier: { marginBottom: -12 }, // the transcript's gap
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
  handoffIcon: { width: 32, height: 32, borderRadius: 8, backgroundColor: "rgba(14,165,233,0.15)", alignItems: "center", justifyContent: "center" },
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
  // Over the transcript's bottom edge, so it never covers the composer (lifted with it).
  jump: { position: "absolute", bottom: 10, alignSelf: "center" },
  jumpButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  disabled: { opacity: 0.35 },
});
