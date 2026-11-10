import type { TranscriptItem } from "@apollo/client";
import type { ArtifactKind, ArtifactRef, AttachmentRef, SessionId } from "@apollo/contracts";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useApollo } from "./AppState.tsx";
import { artifactFile, artifactText, attachmentFile, FALLBACK_IS_PAGE, formatSize, recordingFrames, shareArtifact, shareFile } from "./artifacts.ts";
import { errorMessage } from "./connection.ts";
import { ChevronDownIcon, FileCodeIcon, FileIcon, FileTextIcon, type Icon, ImageIcon, LayoutTemplateIcon, Maximize2Icon, RotateCwIcon, ShareIcon, XIcon } from "./icons.tsx";
import { CodeBlock, Markdown } from "./Markdown.tsx";
import { colors } from "./theme.ts";

type VisualItem = Extract<TranscriptItem, { kind: "visual" }>;
type RecordingItem = Extract<TranscriptItem, { kind: "recording" }>;

const ICONS: Record<ArtifactKind, Icon> = {
  html: LayoutTemplateIcon,
  markdown: FileTextIcon,
  code: FileCodeIcon,
  text: FileTextIcon,
  image: ImageIcon,
  file: FileIcon,
};

/** Inline pages stop growing here unless expanded; the full-screen view shows all of it. */
const MAX_HEIGHT = 560;
const MAX_TEXT = 400 * 1024;
const LONG_TEXT = 4000;

/**
 * Dark defaults with zero specificity (the page's own styles win), and a script that reports
 * the content height so the card fits it.
 */
const prepare = (html: string) => {
  const base = `<meta name="viewport" content="width=device-width,initial-scale=1"><style>:where(html){color-scheme:dark;color:#e4e4e7;background:transparent;font-family:-apple-system,system-ui,sans-serif}:where(body){margin:0;padding:12px}</style>`;
  const sizer = `<script>(()=>{const post=()=>{const b=document.body;if(!b)return;const s=getComputedStyle(b);window.ReactNativeWebView.postMessage(String(Math.ceil(b.scrollHeight+parseFloat(s.marginTop)+parseFloat(s.marginBottom))))};new ResizeObserver(post).observe(document.body||document.documentElement);addEventListener("load",post);post();})()</script>`;
  const withBase = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + base)
    : /<html[^>]*>/i.test(html)
      ? html.replace(/<html[^>]*>/i, (m) => `${m}<head>${base}</head>`)
      : /^\s*<!doctype/i.test(html)
        ? html.replace(/^\s*<!doctype[^>]*>/i, (m) => m + base)
        : base + html;
  return withBase + sizer;
};

/** An agent-written page. Links it opens go to the phone's browser, never inside the card. */
function Page({ html, height, onHeight, scroll }: { html: string; height: number | "fill"; onHeight?: (h: number) => void; scroll: boolean }) {
  const source = useMemo(() => ({ html: prepare(html) }), [html]);
  return (
    <WebView
      source={source}
      originWhitelist={["*"]}
      style={[{ backgroundColor: "transparent" }, height === "fill" ? { flex: 1 } : { height }]}
      scrollEnabled={scroll}
      nestedScrollEnabled
      setSupportMultipleWindows={false}
      allowsInlineMediaPlayback
      onMessage={(e: WebViewMessageEvent): void => {
        const next = Number(e.nativeEvent.data);
        if (Number.isFinite(next) && next > 0) onHeight?.(Math.max(next, 60));
      }}
      onShouldStartLoadWithRequest={(request): boolean => {
        if (/^(about|data|blob):/.test(request.url) || !request.isTopFrame) return true;
        void Linking.openURL(request.url).catch(() => {});
        return false;
      }}
    />
  );
}

function HeaderButton({ icon: I, label, onPress }: { icon: Icon; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityLabel={label} style={({ pressed }) => [styles.headerButton, pressed && { opacity: 0.5 }]}>
      <I size={15} color={colors.muted} />
    </Pressable>
  );
}

function Frame({
  icon,
  title,
  meta,
  children,
  onOpen,
  onShare,
  expand,
}: {
  icon: Icon;
  title: string;
  meta?: string | undefined;
  children: ReactNode;
  onOpen?: (() => void) | undefined;
  onShare?: (() => void) | undefined;
  expand?: { expanded: boolean; toggle: () => void } | undefined;
}) {
  const I = icon;
  return (
    <View style={styles.frame}>
      <View style={styles.caption}>
        <I size={14} color="#5eead4" strokeWidth={1.75} />
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {meta ?? ""}
        </Text>
        {expand ? (
          <Pressable onPress={expand.toggle} hitSlop={8} accessibilityLabel={expand.expanded ? "Collapse" : "Show all"} style={styles.headerButton}>
            <View style={expand.expanded ? { transform: [{ rotate: "180deg" }] } : undefined}>
              <ChevronDownIcon size={15} color={colors.muted} />
            </View>
          </Pressable>
        ) : null}
        {onOpen ? <HeaderButton icon={Maximize2Icon} label="Open full screen" onPress={onOpen} /> : null}
        {onShare ? <HeaderButton icon={ShareIcon} label="Share or save" onPress={onShare} /> : null}
      </View>
      {children}
    </View>
  );
}

function Viewer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[styles.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.viewerHeader}>
          <Text style={styles.viewerTitle} numberOfLines={1}>
            {title}
          </Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
            <XIcon size={20} color={colors.muted} />
          </Pressable>
        </View>
        {children}
      </View>
    </Modal>
  );
}

function Loading() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="small" color={colors.faint} />
      <Text style={styles.note}>Loading…</Text>
    </View>
  );
}

/** A page an agent showed (apollo_show_html), in a card that fits its content. */
export function VisualCard({ item }: { item: VisualItem }) {
  const title = item.title || "Visual";
  const [open, setOpen] = useState(false);
  return (
    <>
      <InlinePage icon={LayoutTemplateIcon} title={title} html={item.html} initialHeight={item.height} onOpen={() => setOpen(true)} />
      {open ? (
        <Viewer title={title} onClose={() => setOpen(false)}>
          <Page html={item.html} height="fill" scroll />
        </Viewer>
      ) : null}
    </>
  );
}

function InlinePage({
  icon,
  title,
  meta,
  html,
  initialHeight,
  onOpen,
  onShare,
}: {
  icon: Icon;
  title: string;
  meta?: string;
  html: string;
  initialHeight: number | null;
  onOpen: () => void;
  onShare?: () => void;
}) {
  const [height, setHeight] = useState(initialHeight ?? 240);
  const [expanded, setExpanded] = useState(false);
  return (
    <Frame
      icon={icon}
      title={title}
      meta={meta}
      onOpen={onOpen}
      onShare={onShare}
      expand={height > MAX_HEIGHT ? { expanded, toggle: () => setExpanded(!expanded) } : undefined}
    >
      <Page html={html} height={expanded ? height : Math.min(height, MAX_HEIGHT)} onHeight={setHeight} scroll={false} />
    </Frame>
  );
}

/** Loads what the card shows: the text of textual artifacts, or the local file of images. */
function useArtifact(a: ArtifactRef, want: "text" | "file" | null) {
  const { pairing } = useApollo();
  const [state, setState] = useState<{ text: string | null; uri: string | null; error: string | null }>({ text: null, uri: null, error: null });
  useEffect(() => {
    if (!want) return;
    let cancelled = false;
    const load = want === "text" ? artifactText(pairing, a).then((text) => ({ text, uri: null })) : artifactFile(pairing, a).then((f) => ({ text: null, uri: f.uri }));
    load.then(
      (next) => !cancelled && setState({ ...next, error: null }),
      (e: unknown) => !cancelled && setState({ text: null, uri: null, error: errorMessage(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [pairing, a.botId, a.artifactId, a.version, want]);
  return state;
}

/**
 * A file a bot saved with apollo_artifact_save, drawn by kind as the desktop app does: pages,
 * formatted Markdown, highlighted code, images, and anything else to share or save.
 */
export function ArtifactCard({ item, artifact: a }: { item: VisualItem; artifact: ArtifactRef }) {
  const { pairing } = useApollo();
  const pageInline = a.kind === "html" && a.size <= FALLBACK_IS_PAGE;
  const textual = a.kind === "markdown" || a.kind === "code" || a.kind === "text" || (a.kind === "html" && !pageInline);
  const { text, uri, error } = useArtifact(a, textual ? "text" : a.kind === "image" ? "file" : null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const title = a.title || a.name;
  const meta = `${a.name !== title ? `${a.name} · ` : ""}v${a.version}`;
  const share = () => {
    setShareError(null);
    shareArtifact(pairing, a).catch((e: unknown) => setShareError(errorMessage(e)));
  };
  const frame = { icon: ICONS[a.kind], title, meta, onShare: share };
  const shareNote = shareError ? <Text style={[styles.note, { color: colors.red }]}>{shareError}</Text> : null;

  if (error) {
    return (
      <Frame {...frame}>
        <Text style={styles.note}>{error}</Text>
      </Frame>
    );
  }

  if (a.kind === "html") {
    const html = pageInline ? item.html : text;
    if (html === null)
      return (
        <Frame {...frame}>
          <Loading />
        </Frame>
      );
    return (
      <>
        <InlinePage {...frame} html={html} initialHeight={pageInline ? item.height : null} onOpen={() => setOpen(true)} />
        {shareNote}
        {open ? (
          <Viewer title={title} onClose={() => setOpen(false)}>
            <Page html={html} height="fill" scroll />
          </Viewer>
        ) : null}
      </>
    );
  }

  if (a.kind === "image") {
    return (
      <>
        <Frame {...frame} onOpen={uri ? () => setOpen(true) : undefined}>
          {uri ? (
            <Pressable onPress={() => setOpen(true)} accessibilityLabel={`${title}, open full screen`}>
              <Image source={{ uri }} style={styles.image} resizeMode="contain" accessibilityIgnoresInvertColors />
            </Pressable>
          ) : (
            <Loading />
          )}
          {shareNote}
        </Frame>
        {open && uri ? (
          <Viewer title={title} onClose={() => setOpen(false)}>
            <ScrollView maximumZoomScale={5} minimumZoomScale={1} centerContent contentContainerStyle={{ flexGrow: 1 }}>
              <Image source={{ uri }} style={{ flex: 1 }} resizeMode="contain" />
            </ScrollView>
          </Viewer>
        ) : null}
      </>
    );
  }

  if (a.kind === "file") {
    return (
      <Frame {...frame}>
        <Pressable onPress={share} style={({ pressed }) => [styles.download, pressed && { opacity: 0.5 }]}>
          <ShareIcon size={14} color={colors.muted} />
          <Text style={styles.downloadText}>
            Save or share {a.name} ({formatSize(a.size)})
          </Text>
        </Pressable>
        {shareNote}
      </Frame>
    );
  }

  if (text === null)
    return (
      <Frame {...frame}>
        <Loading />
      </Frame>
    );
  const shown = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const long = text.length > LONG_TEXT || text.split("\n").length > 26;
  const body = (
    <>
      {a.kind === "markdown" ? (
        <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
          <Markdown text={shown} />
        </View>
      ) : (
        <CodeBlock code={shown} lang={a.kind === "code" ? (a.language ?? null) : null} />
      )}
      {shown.length < text.length ? <Text style={styles.note}>Only the first {formatSize(MAX_TEXT)} are shown; share it for the rest.</Text> : null}
    </>
  );
  return (
    <>
      <Frame {...frame} onOpen={() => setOpen(true)} expand={long ? { expanded, toggle: () => setExpanded(!expanded) } : undefined}>
        <View style={long && !expanded ? styles.clipped : undefined}>{body}</View>
        {shareNote}
      </Frame>
      {open ? (
        <Viewer title={title} onClose={() => setOpen(false)}>
          <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>{body}</ScrollView>
        </Viewer>
      ) : null}
    </>
  );
}

function Attachment({ sessionId, attachment: a }: { sessionId: SessionId; attachment: AttachmentRef }) {
  const { pairing } = useApollo();
  const image = a.mime.startsWith("image/");
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    attachmentFile(pairing, sessionId, a).then(
      (f) => !cancelled && setUri(f.uri),
      (e: unknown) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [pairing, sessionId, a.id, image]);
  const share = () => {
    setError(null);
    attachmentFile(pairing, sessionId, a)
      .then((f) => shareFile(f, a.name))
      .catch((e: unknown) => setError(errorMessage(e)));
  };
  if (image && !error) {
    return (
      <>
        <Pressable onPress={() => uri && setOpen(true)} accessibilityLabel={a.name} style={styles.thumb}>
          {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <ActivityIndicator color={colors.faint} />}
        </Pressable>
        {open && uri ? (
          <Viewer title={a.name} onClose={() => setOpen(false)}>
            <ScrollView maximumZoomScale={5} minimumZoomScale={1} centerContent contentContainerStyle={{ flexGrow: 1 }}>
              <Image source={{ uri }} style={{ flex: 1 }} resizeMode="contain" />
            </ScrollView>
          </Viewer>
        ) : null}
      </>
    );
  }
  return (
    <Pressable onPress={share} style={({ pressed }) => [styles.chip, pressed && { opacity: 0.5 }]} accessibilityLabel={`${a.name}, share or save`}>
      <FileTextIcon size={16} color={colors.muted} />
      <View style={{ flexShrink: 1 }}>
        <Text style={styles.chipName} numberOfLines={1}>
          {a.name}
        </Text>
        <Text style={[styles.chipSize, error ? { color: colors.red } : null]} numberOfLines={2}>
          {error ?? formatSize(a.size)}
        </Text>
      </View>
    </Pressable>
  );
}

/** Files sent with a message: images as thumbnails (tap for full screen), others to share or save. */
export function MessageAttachments({ sessionId, attachments }: { sessionId: SessionId; attachments: ReadonlyArray<AttachmentRef> }) {
  return (
    <View style={styles.attachments}>
      {attachments.map((a) => (
        <Attachment key={a.id} sessionId={sessionId} attachment={a} />
      ))}
    </View>
  );
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A browser recording an agent made: its frames played back at their real pace. Tap to play or pause. */
export function RecordingCard({ item }: { item: RecordingItem }) {
  const { pairing } = useApollo();
  const [uris, setUris] = useState<ReadonlyArray<string> | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const step = item.frames > 1 ? item.durationMs / item.frames : 250;
  const last = Math.max(item.frames - 1, 0);

  useEffect(() => {
    let cancelled = false;
    recordingFrames(pairing, item.recordingId, item.frames, (done) => !cancelled && setProgress(done)).then(
      (next) => !cancelled && setUris(next),
      (e: unknown) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [pairing, item.recordingId, item.frames]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setFrame((f) => {
        if (f >= last) {
          setPlaying(false);
          return f;
        }
        return f + 1;
      });
    }, step);
    return () => clearInterval(timer);
  }, [playing, step, last]);

  const toggle = () => {
    if (!uris) return;
    if (frame >= last) setFrame(0);
    setPlaying(!playing);
  };
  const aspect = item.width && item.height ? item.width / item.height : 16 / 10;
  const uri = uris?.[frame];
  return (
    <Frame icon={LayoutTemplateIcon} title={item.title} meta={clock(item.durationMs)}>
      {error ? (
        <Text style={styles.note}>{error}</Text>
      ) : (
        <Pressable onPress={toggle} accessibilityLabel={playing ? "Pause" : "Play"} style={{ backgroundColor: "#000", aspectRatio: aspect, maxHeight: 420 }}>
          {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="contain" /> : null}
          {!playing ? (
            <View style={styles.playOverlay}>
              {uris ? (
                <View style={styles.playButton}>
                  {frame >= last && frame > 0 ? <RotateCwIcon size={20} color="#fff" /> : <Text style={styles.playGlyph}>▶</Text>}
                </View>
              ) : (
                <Text style={styles.note}>
                  Loading {progress}/{item.frames}…
                </Text>
              )}
            </View>
          ) : null}
        </Pressable>
      )}
      {uris ? (
        <Text style={[styles.note, { paddingVertical: 6, textAlign: "right" }]}>
          {clock(frame * step)} / {clock(item.durationMs)}
        </Text>
      ) : null}
    </Frame>
  );
}

const styles = StyleSheet.create({
  attachments: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 },
  thumb: { width: 120, height: 96, borderRadius: 12, borderWidth: 1, borderColor: colors.border, overflow: "hidden", alignItems: "center", justifyContent: "center", backgroundColor: colors.panelSoft },
  chip: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 240, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelSoft },
  chipName: { color: colors.textSoft, fontSize: 13 },
  chipSize: { color: colors.faint, fontSize: 11 },
  playOverlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.2)" },
  playButton: { width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" },
  playGlyph: { color: "#fff", fontSize: 18, marginLeft: 3 },
  frame: { borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, overflow: "hidden" },
  caption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 38,
    paddingLeft: 12,
    paddingRight: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.panelSoft,
  },
  title: { color: colors.textSoft, fontSize: 13, fontWeight: "600", flexShrink: 1 },
  meta: { color: colors.faint, fontSize: 12, flex: 1 },
  headerButton: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  loading: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  note: { color: colors.faint, fontSize: 12, paddingHorizontal: 12, paddingVertical: 10 },
  image: { width: "100%", height: 280, backgroundColor: colors.bg },
  download: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
  downloadText: { color: colors.muted, fontSize: 13 },
  clipped: { maxHeight: 420, overflow: "hidden" },
  viewer: { flex: 1, backgroundColor: colors.bg },
  viewerHeader: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  viewerTitle: { color: colors.text, fontSize: 16, fontWeight: "600", flex: 1 },
});
