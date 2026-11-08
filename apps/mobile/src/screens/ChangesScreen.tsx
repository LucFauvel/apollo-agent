import { codeLanguage, codePlainColor, highlightCode } from "@apollo/client";
import type {
  ChangeReport,
  ChangesOverview,
  OverviewFile,
  PullRequest,
  RepoChanges,
  SemanticFileDiff,
  SemanticSymbol,
  Session,
  SessionId,
} from "@apollo/contracts";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApollo } from "../AppState.tsx";
import { errorMessage } from "../connection.ts";
import {
  BoxIcon,
  BracesIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  ClockIcon,
  FolderGitIcon,
  GitCompareArrowsIcon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HashIcon,
  HeadingIcon,
  type Icon,
  LayersIcon,
  SparklesIcon,
  SquareFunctionIcon,
  TypeIcon,
} from "../icons.tsx";
import { animateLayout, FadeIn, Turn, useToggle } from "../motion.tsx";
import { colors } from "../theme.ts";

/**
 * What the agents changed, and their pull requests: the phone's version of the desktop's
 * Changes panel, from the same server calls. The file lists, the grouping by declaration
 * and the diffs are computed by Apollo; only the ✦ explanations come from the worker.
 */

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";
const CODE_SIZE = 11.5;
const CODE_CHAR = CODE_SIZE * 0.61;
const VIOLET = "#c4b5fd";
const GREEN = "#34d399";
const RED = "#f87171";

export function ChangesScreen({
  session,
  onBack,
  onOpenSession,
}: {
  session: Session;
  onBack: () => void;
  onOpenSession: (id: SessionId) => void;
}) {
  const { state, connection } = useApollo();
  const version = state.changesVersion.get(session.botId) ?? 0;
  const [overview, setOverview] = useState<ChangesOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    let cancelled = false;
    connection
      .rpc((c) => c["changes.list"]({ sessionId: session.id }))
      .then((next) => !cancelled && (setOverview(next), setError(null)))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [connection, session.id, version]);

  const pullRequests = useMemo(() => {
    const ids = new Set(
      session.role === "main" ? [...state.sessions.values()].filter((s) => s.botId === session.botId).map((s) => s.id) : [session.id],
    );
    const byUrl = new Map<string, PullRequest>();
    for (const pr of state.pullRequests.values()) if (ids.has(pr.sessionId) && (byUrl.get(pr.url)?.updatedAt ?? 0) < pr.updatedAt) byUrl.set(pr.url, pr);
    return [...byUrl.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [state.pullRequests, state.sessions, session]);

  const fileCount = overview?.sessions.reduce((n, s) => n + s.repos.reduce((m, r) => m + r.files.length, 0), 0) ?? 0;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <GitCompareArrowsIcon size={18} color={colors.muted} />
        <Text style={styles.title}>Changes</Text>
        {fileCount > 0 ? (
          <View style={styles.countPill}>
            <Text style={styles.countText}>
              {fileCount} {fileCount === 1 ? "file" : "files"}
            </Text>
          </View>
        ) : null}
      </View>
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {overview === null && !error ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.muted} />
          </View>
        ) : null}
        {overview && overview.sessions.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <GitCompareArrowsIcon size={22} color={colors.faint} strokeWidth={1.5} />
            </View>
            <Text style={styles.emptyTitle}>No changes yet</Text>
            <Text style={styles.emptyText}>
              Files the agents change in git repositories show up here after each turn, grouped by the functions and types they touch.
            </Text>
          </View>
        ) : null}
        {overview?.sessions.map((changes) => (
          <FadeIn key={changes.sessionId}>
            <View style={styles.section}>
              {overview.sessions.length > 1 || changes.sessionId !== session.id ? (
                <Pressable onPress={() => onOpenSession(changes.sessionId as SessionId)} style={styles.sectionTitle} hitSlop={6}>
                  <LayersIcon size={14} color={colors.faint} />
                  <Text style={styles.sectionLabel} numberOfLines={1}>
                    {changes.title}
                  </Text>
                  <View style={styles.rule} />
                </Pressable>
              ) : null}
              {changes.summaries.length > 0 ? <Summaries summaries={changes.summaries} /> : null}
              {changes.repos.map((repo) => (
                <RepoCard key={repo.repo} sessionId={changes.sessionId as SessionId} repo={repo} version={version} />
              ))}
            </View>
          </FadeIn>
        ))}
        <PullRequests pullRequests={pullRequests} />
      </ScrollView>
    </View>
  );
}

// --- worker summaries ------------------------------------------------------------

/** Whether the worker's explanations are folded, for the rest of this app session. */
let explanationsFolded = false;

/** The worker's explanations; folds to one line from its header. */
function Summaries({ summaries }: { summaries: ReadonlyArray<{ text: string; at: number }> }) {
  const [folded, setFolded] = useState(explanationsFolded);
  const [all, toggleAll] = useToggle();
  const [latest, ...older] = summaries;
  return (
    <View style={styles.summary}>
      <Pressable
        onPress={() => {
          animateLayout();
          explanationsFolded = !folded;
          setFolded(!folded);
        }}
        hitSlop={6}
        style={styles.rowCenter}
      >
        <SparklesIcon size={12} color={VIOLET} />
        <Text style={styles.summaryLabel}>EXPLAINED BY THE WORKER</Text>
        {folded ? (
          <Text style={styles.summaryPreview} numberOfLines={1}>
            {latest!.text}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <Turn open={!folded}>
          <ChevronRightIcon size={14} color="rgba(196,181,253,0.6)" />
        </Turn>
      </Pressable>
      {folded ? null : (
        <>
          <Text style={styles.summaryText}>{latest!.text}</Text>
          {older.length > 0 ? (
            <>
              {all
                ? older.map((s) => (
                    <Text key={s.at} style={styles.olderText}>
                      <Text style={styles.olderTime}>{new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} </Text>
                      {s.text}
                    </Text>
                  ))
                : null}
              <Pressable onPress={toggleAll} hitSlop={8}>
                <Text style={styles.olderToggle}>{all ? "Show less" : `${older.length} earlier ${older.length === 1 ? "explanation" : "explanations"}`}</Text>
              </Pressable>
            </>
          ) : null}
        </>
      )}
    </View>
  );
}

// --- repositories and files ------------------------------------------------------------

const STATUS: Record<OverviewFile["status"], { letter: string; fg: string; bg: string }> = {
  added: { letter: "A", fg: "#6ee7b7", bg: "rgba(16,185,129,0.15)" },
  modified: { letter: "M", fg: "#fcd34d", bg: "rgba(245,158,11,0.15)" },
  deleted: { letter: "D", fg: "#fca5a5", bg: "rgba(239,68,68,0.15)" },
  renamed: { letter: "R", fg: "#7dd3fc", bg: "rgba(14,165,233,0.15)" },
};

function Counts({ additions, deletions, binary = false }: { additions: number; deletions: number; binary?: boolean }) {
  if (binary) return <Text style={styles.binary}>binary</Text>;
  return (
    <Text style={styles.counts}>
      <Text style={{ color: GREEN }}>+{additions}</Text> <Text style={{ color: RED }}>−{deletions}</Text>
    </Text>
  );
}

function RepoCard({ sessionId, repo, version }: { sessionId: SessionId; repo: { repo: string; name: string; files: ReadonlyArray<OverviewFile> }; version: number }) {
  const [closed, toggle] = useToggle();
  const additions = repo.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = repo.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <View style={styles.card}>
      <Pressable onPress={toggle} style={({ pressed }) => [styles.repoHeader, pressed && styles.pressed]}>
        <FolderGitIcon size={16} color={colors.muted} strokeWidth={1.75} />
        <Text style={styles.repoName} numberOfLines={1}>
          {repo.name}
        </Text>
        <Text style={styles.faintSmall}>
          {repo.files.length} {repo.files.length === 1 ? "file" : "files"}
        </Text>
        <View style={{ flex: 1 }} />
        <Counts additions={additions} deletions={deletions} />
        <Turn open={!closed}>
          <ChevronRightIcon size={14} color={colors.faint} />
        </Turn>
      </Pressable>
      {!closed
        ? repo.files.map((file) => <FileRow key={file.path} sessionId={sessionId} repo={repo.repo} file={file} version={version} />)
        : null}
    </View>
  );
}

function FileRow({
  sessionId,
  repo,
  file,
  version,
  reportSeq,
}: {
  sessionId: SessionId;
  repo: string;
  file: OverviewFile;
  version: number;
  reportSeq?: number | undefined;
}) {
  const [open, toggle] = useToggle();
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = file.path.slice(slash + 1);
  const status = STATUS[file.status];
  return (
    <View style={[styles.fileRow, open && styles.fileRowOpen]}>
      <Pressable onPress={toggle} style={({ pressed }) => [styles.fileHeader, pressed && styles.pressed]}>
        <View style={[styles.status, { backgroundColor: status.bg }]}>
          <Text style={[styles.statusText, { color: status.fg }]}>{status.letter}</Text>
        </View>
        <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
          <Text style={{ color: colors.faint }}>{dir}</Text>
          <Text style={[{ color: colors.textSoft }, file.status === "deleted" && styles.struck]}>{name}</Text>
        </Text>
        {file.note ? <SparklesIcon size={12} color={VIOLET} /> : null}
        <Counts additions={file.additions ?? 0} deletions={file.deletions ?? 0} binary={file.additions === null} />
        <Turn open={open}>
          <ChevronRightIcon size={14} color="#52525b" />
        </Turn>
      </Pressable>
      {!open && file.note ? (
        <Text style={styles.notePreview} numberOfLines={1}>
          {file.note}
        </Text>
      ) : null}
      {/* Outside the tap target, so code inside can scroll sideways without closing the file. */}
      {open ? <FileDiff sessionId={sessionId} repo={repo} path={file.path} version={version} reportSeq={reportSeq} /> : null}
    </View>
  );
}

// --- the full diff of a repository the user asked for (shown in the conversation) -----------

/**
 * The full semantic diff of a repository (`apollo_semantic_diff`): every file that differs
 * from its baseline, whichever turn changed it, as of when it was asked (the desktop's FullDiff).
 */
export function FullDiff({ sessionId, seq, repo, report }: { sessionId: SessionId; seq: number; repo: RepoChanges; report: ChangeReport }) {
  const [closed, toggle] = useToggle();
  const [commitsOpen, toggleCommits] = useToggle();
  const notes = useMemo(() => new Map(report.notes.map((n) => [n.path, n.text])), [report.notes]);
  const additions = repo.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = repo.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const total = repo.files.length + report.moreFiles;
  const base = report.base.commit ? `${report.base.ref} @ ${report.base.commit.slice(0, 7)}` : report.base.ref;
  return (
    <View style={styles.card}>
      <Pressable onPress={toggle} style={({ pressed }) => [styles.repoHeader, pressed && styles.pressed]}>
        <GitCompareArrowsIcon size={16} color={colors.muted} strokeWidth={1.75} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.repoName} numberOfLines={1}>
            Full diff · {repo.name}
          </Text>
          <Text style={styles.faintSmall} numberOfLines={1}>
            vs {base} · {total} {total === 1 ? "file" : "files"}
          </Text>
        </View>
        <Counts additions={additions} deletions={deletions} />
        <Turn open={!closed}>
          <ChevronRightIcon size={14} color={colors.faint} />
        </Turn>
      </Pressable>
      {!closed ? (
        <>
          <Pressable onPress={report.commitCount > 0 ? toggleCommits : undefined} style={[styles.indent, { paddingVertical: 6 }]}>
            <Text style={styles.faintSmall}>
              {report.head.branch ? `${report.head.branch} · ` : ""}
              {report.commitCount > 0
                ? `${report.commitCount} ${report.commitCount === 1 ? "commit" : "commits"} since the base ${commitsOpen ? "▾" : "▸"}`
                : "No commits since the base"}
              {report.uncommitted ? " · + uncommitted changes" : ""}
            </Text>
          </Pressable>
          {commitsOpen
            ? report.commits.map((c) => (
                <Text key={c.sha} style={[styles.faintSmall, styles.indent]} numberOfLines={1}>
                  <Text style={{ fontFamily: MONO }}>{c.sha}</Text> <Text style={{ color: colors.textSoft }}>{c.subject}</Text>
                </Text>
              ))
            : null}
          {repo.files.length === 0 ? <Text style={[styles.faintSmall, styles.indent, { paddingBottom: 8 }]}>Nothing differs from the base.</Text> : null}
          {repo.files.map((file) => (
            <FileRow
              key={file.path}
              sessionId={sessionId}
              repo={repo.repo}
              file={{ ...file, note: notes.get(file.path) ?? null }}
              version={0}
              reportSeq={seq}
            />
          ))}
          {report.moreFiles > 0 ? (
            <Text style={[styles.omitted, styles.indent, { paddingVertical: 8 }]}>
              and {report.moreFiles} more {report.moreFiles === 1 ? "file" : "files"}, not listed: ask for a diff against a closer base
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

// --- the semantic diff of one file ----------------------------------------------------------

function FileDiff({
  sessionId,
  repo,
  path,
  version,
  reportSeq,
}: {
  sessionId: SessionId;
  repo: string;
  path: string;
  version: number;
  reportSeq?: number | undefined;
}) {
  const { connection } = useApollo();
  const [diff, setDiff] = useState<SemanticFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    connection
      .rpc((c) => c["changes.file"]({ sessionId, repo, path, ...(reportSeq !== undefined ? { reportSeq } : {}) }))
      .then((next) => !cancelled && (setDiff(next), setError(null)))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [connection, sessionId, repo, path, version, reportSeq]);

  if (error) return <Text style={[styles.error, styles.indent]}>{error}</Text>;
  if (!diff) {
    return (
      <View style={[styles.rowCenter, styles.indent, { paddingBottom: 12 }]}>
        <ActivityIndicator size="small" color={colors.faint} />
        <Text style={styles.faintSmall}>Reading the diff…</Text>
      </View>
    );
  }
  const language = codeLanguage(path.split(".").pop() ?? null);
  return (
    <FadeIn>
      <View style={styles.diff}>
        {diff.note ? <Note text={diff.note} /> : null}
        {diff.omitted ? <Text style={styles.omitted}>{diff.omitted}</Text> : null}
        {diff.symbols.map((symbol) => (
          <SymbolRow key={symbol.name} symbol={symbol} language={language} single={diff.symbols.length === 1} />
        ))}
      </View>
    </FadeIn>
  );
}

function Note({ text }: { text: string }) {
  return (
    <View style={styles.note}>
      <SparklesIcon size={12} color={VIOLET} />
      <Text style={styles.noteText}>{text}</Text>
    </View>
  );
}

const KIND: Record<SemanticSymbol["kind"], { icon: Icon; color: string }> = {
  function: { icon: SquareFunctionIcon, color: "#7dd3fc" },
  method: { icon: SquareFunctionIcon, color: "#67e8f9" },
  class: { icon: BoxIcon, color: "#fcd34d" },
  type: { icon: TypeIcon, color: "#5eead4" },
  constant: { icon: HashIcon, color: "#f0abfc" },
  section: { icon: HeadingIcon, color: VIOLET },
  module: { icon: BracesIcon, color: colors.muted },
};

const CHANGE: Record<SemanticSymbol["change"], { label: string; fg: string; bg: string }> = {
  added: { label: "ADDED", fg: "#6ee7b7", bg: "rgba(16,185,129,0.15)" },
  removed: { label: "REMOVED", fg: "#fca5a5", bg: "rgba(239,68,68,0.15)" },
  modified: { label: "CHANGED", fg: colors.muted, bg: colors.border },
};

function SymbolRow({ symbol, language, single }: { symbol: SemanticSymbol; language: string | null; single: boolean }) {
  const [toggled, toggle] = useToggle();
  const open = single ? !toggled : toggled;
  const kind = KIND[symbol.kind];
  const change = CHANGE[symbol.change];
  return (
    <View style={styles.symbol}>
      <Pressable onPress={toggle} style={({ pressed }) => [styles.symbolHeader, pressed && styles.pressed]}>
        <kind.icon size={14} color={kind.color} strokeWidth={1.75} />
        <Text style={[styles.symbolName, symbol.change === "removed" && styles.struck]} numberOfLines={1}>
          {symbol.name}
        </Text>
        <View style={[styles.change, { backgroundColor: change.bg }]}>
          <Text style={[styles.changeText, { color: change.fg }]}>{change.label}</Text>
        </View>
        <View style={{ flex: 1 }} />
        {symbol.note ? <SparklesIcon size={12} color={VIOLET} /> : null}
        <Counts additions={symbol.additions} deletions={symbol.deletions} />
        <Turn open={open}>
          <ChevronRightIcon size={12} color="#52525b" />
        </Turn>
      </Pressable>
      {symbol.note ? (
        open ? (
          <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
            <Note text={symbol.note} />
          </View>
        ) : (
          <Text style={styles.symbolNotePreview} numberOfLines={1}>
            {symbol.note}
          </Text>
        )
      ) : null}
      {open ? symbol.hunks.map((hunk, i) => <HunkView key={i} hunk={hunk} language={language} first={i === 0} />) : null}
    </View>
  );
}

const LINE = {
  add: { bg: "rgba(16,185,129,0.10)", gutter: "rgba(16,185,129,0.75)", sign: "+" },
  del: { bg: "rgba(239,68,68,0.10)", gutter: "rgba(239,68,68,0.75)", sign: "−" },
  ctx: { bg: "transparent", gutter: "#3f3f46", sign: " " },
} as const;

/** A hunk, highlighted as one piece; it scrolls sideways, the line numbers stay put. */
function HunkView({ hunk, language, first }: { hunk: SemanticSymbol["hunks"][number]; language: string | null; first: boolean }) {
  const spans = useMemo(() => highlightCode(hunk.lines.map((l) => l.text).join("\n"), language), [hunk, language]);
  const longest = useMemo(() => hunk.lines.reduce((n, l) => Math.max(n, l.text.length), 0), [hunk]);
  const width = Math.ceil(longest * CODE_CHAR) + 24;
  return (
    <View style={[styles.hunk, !first && styles.hunkSeparated]}>
      <View>
        {hunk.lines.map((line, i) => (
          <View key={i} style={[styles.gutterRow, { backgroundColor: LINE[line.kind].bg }]}>
            <Text style={[styles.gutter, { color: LINE[line.kind].gutter }]}>{line.oldNo ?? ""}</Text>
            <Text style={[styles.gutter, { color: LINE[line.kind].gutter }]}>{line.newNo ?? ""}</Text>
            <Text style={[styles.sign, { color: LINE[line.kind].gutter }]}>{LINE[line.kind].sign}</Text>
          </View>
        ))}
      </View>
      <ScrollView horizontal nestedScrollEnabled directionalLockEnabled showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
        <View style={{ minWidth: width }}>
          {hunk.lines.map((line, i) => (
            <View key={i} style={[styles.codeRow, { backgroundColor: LINE[line.kind].bg }]}>
              <Text style={styles.code} numberOfLines={1} selectable>
                {(spans[i] ?? [{ text: line.text }]).map((span, j) => (
                  <Text key={j} style={span.color || span.fontStyle ? { color: span.color, fontStyle: span.fontStyle } : undefined}>
                    {span.text}
                  </Text>
                ))}
                {line.text === "" ? " " : ""}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

// --- pull requests ----------------------------------------------------------------------

function PullRequests({ pullRequests }: { pullRequests: ReadonlyArray<PullRequest> }) {
  const [showMerged, toggle] = useToggle();
  if (pullRequests.length === 0) return null;
  const active = pullRequests.filter((pr) => pr.state === "open" || pr.state === "draft");
  const done = pullRequests.filter((pr) => pr.state === "merged" || pr.state === "closed");
  return (
    <FadeIn>
      <View style={styles.section}>
        <View style={styles.sectionTitle}>
          <GitPullRequestIcon size={14} color={colors.faint} />
          <Text style={styles.sectionLabel}>PULL REQUESTS</Text>
          <View style={styles.rule} />
        </View>
        {active.length === 0 ? <Text style={styles.faintSmall}>No open pull requests.</Text> : null}
        {active.map((pr) => (
          <PullRequestRow key={pr.url} pr={pr} />
        ))}
        {done.length > 0 ? (
          <>
            <Pressable onPress={toggle} style={styles.mergedToggle} hitSlop={8}>
              <Turn open={showMerged}>
                <ChevronRightIcon size={14} color={colors.faint} />
              </Turn>
              <GitMergeIcon size={14} color="rgba(196,181,253,0.75)" />
              <Text style={styles.mergedLabel}>Merged</Text>
              <View style={styles.mergedCount}>
                <Text style={styles.mergedCountText}>{done.length}</Text>
              </View>
            </Pressable>
            {showMerged ? done.map((pr) => <PullRequestRow key={pr.url} pr={pr} />) : null}
          </>
        ) : null}
      </View>
    </FadeIn>
  );
}

const CHECKS: Record<PullRequest["checks"], { icon: Icon; color: string }> = {
  none: { icon: CircleDotIcon, color: colors.faint },
  pending: { icon: ClockIcon, color: "#fcd34d" },
  passing: { icon: CircleCheckIcon, color: GREEN },
  failing: { icon: CircleXIcon, color: RED },
};

function PullRequestRow({ pr }: { pr: PullRequest }) {
  const done = pr.state === "merged" || pr.state === "closed";
  const StateIcon = pr.state === "merged" ? GitMergeIcon : pr.state === "draft" ? GitPullRequestDraftIcon : GitPullRequestIcon;
  const stateColor = pr.state === "merged" ? VIOLET : pr.state === "closed" ? "rgba(252,165,165,0.8)" : pr.state === "draft" ? colors.muted : GREEN;
  const checks = CHECKS[pr.checks];
  const review = pr.review ? pr.review.replace("_", " ") : null;
  return (
    <Pressable onPress={() => void Linking.openURL(pr.url)} style={({ pressed }) => [styles.pr, pressed && styles.pressed]}>
      <StateIcon size={16} color={stateColor} strokeWidth={1.75} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.prTitle, done && { color: colors.muted }]} numberOfLines={1}>
          {pr.title}
        </Text>
        <Text style={styles.prMeta} numberOfLines={1}>
          {pr.repo}#{pr.number}
          {pr.state === "closed" ? <Text style={{ color: "rgba(252,165,165,0.8)" }}> · closed</Text> : null}
          {pr.state === "draft" ? " · draft" : ""}
          {review ? (
            <Text style={{ color: pr.review === "approved" ? GREEN : pr.review === "changes_requested" ? "#fcd34d" : colors.faint }}> · {review}</Text>
          ) : null}
        </Text>
      </View>
      {!done ? pr.checks === "pending" ? <ActivityIndicator size="small" color={checks.color} /> : <checks.icon size={16} color={checks.color} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  back: { color: colors.accent, fontSize: 16, marginRight: 4 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  countPill: { backgroundColor: colors.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  countText: { color: colors.muted, fontSize: 11, fontWeight: "500" },
  body: { padding: 16, gap: 20 },
  loading: { paddingVertical: 40, alignItems: "center" },
  error: { color: RED, fontSize: 13 },
  empty: { alignItems: "center", paddingVertical: 40, paddingHorizontal: 24 },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panelSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  emptyTitle: { color: colors.textSoft, fontSize: 15, fontWeight: "600" },
  emptyText: { color: colors.faint, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 4 },
  section: { gap: 10 },
  sectionTitle: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionLabel: { color: colors.faint, fontSize: 11, fontWeight: "700", letterSpacing: 0.8 },
  rule: { flex: 1, height: 1, backgroundColor: colors.border },
  rowCenter: { flexDirection: "row", alignItems: "center", gap: 6 },
  pressed: { opacity: 0.6 },
  summary: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(139,92,246,0.22)",
    backgroundColor: "rgba(139,92,246,0.07)",
    padding: 12,
    gap: 6,
  },
  summaryLabel: { color: "rgba(196,181,253,0.9)", fontSize: 10.5, fontWeight: "700", letterSpacing: 0.8 },
  summaryText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  summaryPreview: { flex: 1, color: colors.muted, fontSize: 12.5, paddingLeft: 4 },
  olderText: { color: colors.muted, fontSize: 12.5, lineHeight: 18 },
  olderTime: { color: "#52525b", fontSize: 10.5 },
  olderToggle: { color: "rgba(196,181,253,0.75)", fontSize: 12, marginTop: 2 },
  card: { borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: "rgba(24,24,27,0.4)", overflow: "hidden" },
  repoHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
  repoName: { color: colors.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  faintSmall: { color: colors.faint, fontSize: 11.5 },
  counts: { fontFamily: MONO, fontSize: 11 },
  binary: { color: colors.faint, fontSize: 11 },
  fileRow: { borderTopWidth: 1, borderTopColor: "rgba(39,39,42,0.7)" },
  fileRowOpen: { backgroundColor: "rgba(9,9,11,0.5)" },
  fileHeader: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 11 },
  status: { width: 20, height: 20, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  statusText: { fontSize: 10.5, fontWeight: "800" },
  path: { flex: 1, fontFamily: MONO, fontSize: 12.5 },
  struck: { textDecorationLine: "line-through", color: colors.muted },
  notePreview: { color: colors.faint, fontSize: 12, fontStyle: "italic", paddingLeft: 42, paddingRight: 12, paddingBottom: 10, marginTop: -4 },
  indent: { paddingLeft: 42, paddingRight: 12 },
  diff: { paddingLeft: 12, paddingRight: 12, paddingBottom: 12, gap: 8 },
  omitted: { color: colors.faint, fontSize: 12.5, fontStyle: "italic" },
  note: {
    flexDirection: "row",
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(139,92,246,0.18)",
    backgroundColor: "rgba(139,92,246,0.07)",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  noteText: { flex: 1, color: colors.textSoft, fontSize: 13, lineHeight: 19 },
  symbol: { borderRadius: 10, borderWidth: 1, borderColor: "rgba(39,39,42,0.8)", backgroundColor: "rgba(24,24,27,0.5)", overflow: "hidden" },
  symbolHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 10 },
  symbolName: { flexShrink: 1, color: colors.text, fontFamily: MONO, fontSize: 12.5 },
  change: { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  changeText: { fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  symbolNotePreview: { color: colors.faint, fontSize: 12, fontStyle: "italic", paddingHorizontal: 32, paddingBottom: 9, marginTop: -4 },
  hunk: { flexDirection: "row", borderTopWidth: 1, borderTopColor: "rgba(39,39,42,0.8)" },
  hunkSeparated: { borderStyle: "dashed" },
  gutterRow: { flexDirection: "row", height: CODE_SIZE * 1.6 },
  gutter: { width: 30, textAlign: "right", paddingRight: 4, fontFamily: MONO, fontSize: 10, lineHeight: CODE_SIZE * 1.6 },
  sign: { width: 14, textAlign: "center", fontFamily: MONO, fontSize: CODE_SIZE, lineHeight: CODE_SIZE * 1.6 },
  codeRow: { height: CODE_SIZE * 1.6, paddingRight: 12 },
  code: { fontFamily: MONO, fontSize: CODE_SIZE, lineHeight: CODE_SIZE * 1.6, color: codePlainColor },
  mergedToggle: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  mergedLabel: { color: colors.muted, fontSize: 13 },
  mergedCount: { backgroundColor: colors.border, borderRadius: 5, paddingHorizontal: 6 },
  mergedCountText: { color: colors.muted, fontSize: 11 },
  pr: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(24,24,27,0.4)",
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  prTitle: { color: colors.text, fontSize: 14 },
  prMeta: { color: colors.faint, fontSize: 12, marginTop: 2 },
});
