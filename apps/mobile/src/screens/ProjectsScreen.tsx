import { contextConflict, edited, fieldsOf, type ProjectEdit, projectUpdate, rebase, relativeTime, startEdit } from "@apollo/client";
import {
  type Bot,
  type BotId,
  type Memory,
  type Project,
  PROJECT_CONTEXT_LIMIT,
  PROJECT_SUMMARY_LIMIT,
  type ProjectId,
  type SessionId,
} from "@apollo/contracts";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Animated, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApollo } from "../AppState.tsx";
import { errorMessage } from "../connection.ts";
import { ArchiveIcon, ArchiveRestoreIcon, FolderKanbanIcon, PlusIcon, SquarePenIcon, TrashIcon } from "../icons.tsx";
import { useKeyboardInset } from "../motion.tsx";
import { colors } from "../theme.ts";

const byRecent = (a: Project, b: Project) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) || b.updatedAt - a.updatedAt;

export const isBusy = (s: { status: string }) => s.status === "running" || s.status === "starting" || s.status === "waiting-approval";

/** A labelled field, with an optional hint below. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Input(props: React.ComponentProps<typeof TextInput> & { mono?: boolean }) {
  const { mono, style, ...rest } = props;
  return <TextInput placeholderTextColor={colors.faint} autoCorrect={!mono} autoCapitalize={mono ? "none" : "sentences"} {...rest} style={[styles.input, mono && styles.mono, style]} />;
}

export function PrimaryButton({ label, onPress, disabled, busy }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [styles.primary, (disabled || busy) && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}
    >
      {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.primaryText}>{label}</Text>}
    </Pressable>
  );
}

function Counter({ used, limit }: { used: number; limit: number }) {
  return <Text style={{ color: used > limit ? colors.red : colors.faint }}>{` ${used}/${limit}`}</Text>;
}

function ProjectForm({ bot, project, onSaved }: { bot: Bot; project: Project | null; onSaved: (project: Project) => void }) {
  const { connection } = useApollo();
  const [edit, setEdit] = useState<ProjectEdit>(() => startEdit(project));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (project) setEdit((current) => rebase(current, fieldsOf(project)));
  }, [project]);
  const { name, summary, cwd, context } = edit.draft;
  const set = (key: keyof ProjectEdit["draft"]) => (value: string) => setEdit((current) => ({ ...current, draft: { ...current.draft, [key]: value } }));
  const conflict = project ? contextConflict(edit, fieldsOf(project)) : false;

  const save = () => {
    setSaving(true);
    setError(null);
    connection
      .rpc((c) =>
        project
          ? c["projects.update"]({ projectId: project.id, ...projectUpdate(edit) })
          : c["projects.create"]({ botId: bot.id, name, summary, context, cwd: cwd.trim() ? cwd : null }),
      )
      .then((saved) => {
        setEdit(startEdit(saved));
        onSaved(saved);
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  return (
    <View style={{ gap: 14 }}>
      <Field label="Name">
        <Input value={name} onChangeText={set("name")} autoFocus={!project} placeholder="Project name" />
      </Field>
      <Field
        label="Summary"
        hint={
          <>
            One line: what it is and where it stands. It is all {bot.name}'s orchestrator sees of the project.
            <Counter used={summary.length} limit={PROJECT_SUMMARY_LIMIT} />
          </>
        }
      >
        <Input value={summary} onChangeText={set("summary")} multiline />
      </Field>
      <Field label="Workspace" hint={`Where its sessions work. Empty: the bot's (${bot.cwd}).`}>
        <Input value={cwd} onChangeText={set("cwd")} placeholder={bot.cwd} mono />
      </Field>
      <Field
        label="Context"
        hint={
          <>
            Markdown: goals, decisions, status, where things are. Sessions started in the project get it; agents keep it up to date.
            <Counter used={context.length} limit={PROJECT_CONTEXT_LIMIT} />
          </>
        }
      >
        <Input value={context} onChangeText={set("context")} multiline mono style={{ minHeight: 180, textAlignVertical: "top" }} />
      </Field>
      {conflict && project ? (
        <View style={styles.conflict}>
          <Text style={styles.conflictText}>The context changed while you were editing it (an agent updated it). Saving now would replace that change.</Text>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <Pressable
              onPress={() => setEdit((c) => ({ base: { ...c.base, context: project.context }, draft: { ...c.draft, context: project.context } }))}
            >
              <Text style={styles.link}>Use the latest context</Text>
            </Pressable>
            <Pressable onPress={() => setEdit((c) => ({ ...c, base: { ...c.base, context: project.context } }))}>
              <Text style={styles.link}>Keep my edit</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <PrimaryButton
        label={project ? "Save" : "Create project"}
        onPress={save}
        busy={saving}
        disabled={conflict || (project ? edited(edit).length === 0 : !name.trim())}
      />
    </View>
  );
}

function useProjectMemories(project: Project) {
  const { state, connection } = useApollo();
  const version = state.memoryVersion.get(project.botId) ?? 0;
  const [memories, setMemories] = useState<ReadonlyArray<Memory> | null>(null);
  useEffect(() => {
    let cancelled = false;
    connection
      .rpc((c) => c["memory.list"]({ botId: project.botId }))
      .then((all) => !cancelled && setMemories(all.filter((m) => m.projectId === project.id)))
      .catch(() => !cancelled && setMemories([]));
    return () => {
      cancelled = true;
    };
  }, [connection, project.id, project.botId, version]);
  return memories;
}

function ProjectDetail({
  bot,
  project,
  onDeleted,
  onOpenSession,
  onNewSession,
}: {
  bot: Bot;
  project: Project;
  onDeleted: () => void;
  onOpenSession: (id: SessionId) => void;
  onNewSession: (projectId: ProjectId) => void;
}) {
  const { state, connection } = useApollo();
  const inside = useMemo(
    () => [...state.sessions.values()].filter((s) => s.projectId === project.id && s.role !== "reflection").sort((a, b) => b.updatedAt - a.updatedAt),
    [state.sessions, project.id],
  );
  const memories = useProjectMemories(project);
  const [error, setError] = useState<string | null>(null);
  const archived = project.status === "archived";
  const act = (call: Parameters<typeof connection.rpc>[0]) => connection.rpc(call).catch((e: unknown) => setError(errorMessage(e)));

  return (
    <View style={{ gap: 8 }}>
      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          onPress={() => void act((c) => c["projects.update"]({ projectId: project.id, status: archived ? "active" : "archived" }))}
        >
          {archived ? <ArchiveRestoreIcon size={16} color={colors.muted} /> : <ArchiveIcon size={16} color={colors.muted} />}
          <Text style={styles.actionText}>{archived ? "Make active again" : "Archive (done)"}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          onPress={() =>
            Alert.alert(`Delete ${project.name}?`, "Its memories are deleted too. Its sessions stay, outside any project.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete",
                style: "destructive",
                onPress: () =>
                  void connection
                    .rpc((c) => c["projects.delete"]({ projectId: project.id }))
                    .then(onDeleted, (e: unknown) => setError(errorMessage(e))),
              },
            ])
          }
        >
          <TrashIcon size={16} color={colors.red} />
          <Text style={[styles.actionText, { color: colors.red }]}>Delete</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.sectionRow}>
        <Text style={[styles.section, { flex: 1 }]}>Sessions</Text>
        {!archived ? (
          <Pressable onPress={() => onNewSession(project.id)} hitSlop={8} style={styles.sectionButton}>
            <SquarePenIcon size={14} color={colors.accent} />
            <Text style={styles.link}>New session</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.card}>
        {inside.length === 0 ? (
          <Text style={styles.empty}>No sessions yet. Start one here, or ask {bot.name} to delegate work to the project.</Text>
        ) : (
          inside.map((s, i) => (
            <Pressable key={s.id} onPress={() => onOpenSession(s.id)} style={({ pressed }) => [styles.row, i > 0 && styles.rowBorder, pressed && styles.pressed]}>
              <View style={[styles.dot, { backgroundColor: s.status === "waiting-approval" ? colors.amber : s.status === "error" ? colors.red : isBusy(s) ? colors.green : "transparent" }]} />
              <Text style={styles.rowTitle} numberOfLines={1}>
                {s.title}
              </Text>
              <Text style={styles.rowMeta}>{relativeTime(s.updatedAt, Date.now())}</Text>
            </Pressable>
          ))
        )}
      </View>

      <Text style={styles.section}>Project</Text>
      <ProjectForm key={project.id} bot={bot} project={project} onSaved={() => {}} />

      <Text style={styles.section}>Memories{memories ? ` (${memories.length})` : ""}</Text>
      <View style={styles.card}>
        {memories === null ? (
          <ActivityIndicator style={{ padding: 14 }} color={colors.faint} />
        ) : memories.length === 0 ? (
          <Text style={styles.empty}>Facts agents save to the project show up here; only its sessions find them.</Text>
        ) : (
          memories.map((m, i) => (
            <View key={m.id} style={[styles.row, { alignItems: "flex-start" }, i > 0 && styles.rowBorder]}>
              <Text style={[styles.rowTitle, { fontSize: 14 }]} selectable>
                {m.content}
              </Text>
              <Pressable
                hitSlop={8}
                accessibilityLabel="Forget"
                onPress={() =>
                  Alert.alert("Forget this memory?", m.content.slice(0, 200), [
                    { text: "Cancel", style: "cancel" },
                    { text: "Forget", style: "destructive", onPress: () => void act((c) => c["memory.delete"]({ memoryId: m.id })) },
                  ])
                }
              >
                <TrashIcon size={15} color={colors.faint} />
              </Pressable>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

/**
 * A bot's projects: long-standing work whose context and memories stay in it. The list,
 * one project (its sessions, its fields, its memories), or a form for a new one.
 */
export function ProjectsScreen({
  botId,
  focus: initialFocus,
  onBack,
  onOpenSession,
  onNewSession,
}: {
  botId: BotId;
  focus?: ProjectId | null | undefined;
  onBack: () => void;
  onOpenSession: (id: SessionId) => void;
  onNewSession: (botId: BotId, projectId: ProjectId) => void;
}) {
  const { state } = useApollo();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset(insets.bottom);
  const bot = state.bots.get(botId);
  const projects = useMemo(() => [...state.projects.values()].filter((p) => p.botId === botId).sort(byRecent), [state.projects, botId]);
  const [view, setView] = useState<{ kind: "list" } | { kind: "project"; id: ProjectId } | { kind: "create" }>(() =>
    initialFocus ? { kind: "project", id: initialFocus } : { kind: "list" },
  );
  const project = view.kind === "project" ? (state.projects.get(view.id) ?? null) : null;
  const toList = () => setView({ kind: "list" });
  // Started on a project: going back leaves the screen; from the list, back returns there.
  const back = view.kind === "list" || (view.kind === "project" && initialFocus === view.id) ? onBack : toList;

  return (
    <Animated.View style={[styles.screen, { paddingBottom: keyboard }]}>
      <View style={styles.header}>
        <Pressable onPress={back} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <FolderKanbanIcon size={18} color={colors.muted} />
        <Text style={styles.title} numberOfLines={1}>
          {view.kind === "create" ? "New project" : project ? project.name : "Projects"}
        </Text>
        {project?.status === "archived" ? <Text style={styles.badge}>Archived</Text> : null}
        {view.kind === "list" && bot ? (
          <Pressable onPress={() => setView({ kind: "create" })} hitSlop={10} accessibilityLabel="New project" style={styles.headerButton}>
            <PlusIcon size={20} color={colors.accent} />
          </Pressable>
        ) : null}
      </View>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
        {!bot ? null : view.kind === "create" ? (
          <ProjectForm bot={bot} project={null} onSaved={(saved) => setView({ kind: "project", id: saved.id })} />
        ) : project ? (
          <ProjectDetail
            bot={bot}
            project={project}
            onDeleted={initialFocus === project.id ? onBack : toList}
            onOpenSession={onOpenSession}
            onNewSession={(id) => onNewSession(botId, id)}
          />
        ) : view.kind === "project" ? (
          <Text style={styles.empty}>This project no longer exists.</Text>
        ) : projects.length === 0 ? (
          <View style={{ gap: 14, alignItems: "center", paddingTop: 40 }}>
            <FolderKanbanIcon size={28} color={colors.faint} />
            <Text style={[styles.empty, { textAlign: "center" }]}>
              No projects yet. A project holds long-standing work: its context and memories stay in it, {bot.name} knows it by a one-line summary, and
              sessions can be started inside it.
            </Text>
          </View>
        ) : (
          projects.map((p) => {
            const count = [...state.sessions.values()].filter((s) => s.projectId === p.id && s.role !== "reflection").length;
            return (
              <Pressable
                key={p.id}
                onPress={() => setView({ kind: "project", id: p.id })}
                style={({ pressed }) => [styles.card, styles.projectCard, p.status === "archived" && { opacity: 0.6 }, pressed && styles.pressed]}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <FolderKanbanIcon size={15} color={colors.faint} />
                  <Text style={[styles.rowTitle, { fontWeight: "600" }]} numberOfLines={1}>
                    {p.name}
                  </Text>
                  {p.status === "archived" ? <Text style={styles.badge}>Archived</Text> : null}
                  <Text style={styles.rowMeta}>
                    {count} session{count === 1 ? "" : "s"}
                  </Text>
                </View>
                {p.summary ? <Text style={styles.summary}>{p.summary}</Text> : null}
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
  back: { color: colors.accent, fontSize: 16, marginRight: 4 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600", flex: 1 },
  headerButton: { padding: 2 },
  badge: { color: colors.muted, fontSize: 11, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, overflow: "hidden" },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  section: { color: colors.faint, fontSize: 11, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase", marginTop: 14, marginLeft: 4 },
  sectionRow: { flexDirection: "row", alignItems: "center", marginTop: 14 },
  sectionButton: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 14 },
  card: { backgroundColor: colors.panelSoft, borderRadius: 14, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  projectCard: { padding: 14, gap: 6 },
  summary: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  rowTitle: { color: colors.textSoft, fontSize: 15, flex: 1 },
  rowMeta: { color: colors.faint, fontSize: 12 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  empty: { color: colors.muted, fontSize: 13, lineHeight: 19, padding: 14 },
  pressed: { opacity: 0.55 },
  actions: { flexDirection: "row", gap: 10 },
  action: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  actionText: { color: colors.textSoft, fontSize: 14 },
  error: { color: colors.red, fontSize: 13 },
  field: { gap: 6 },
  fieldLabel: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  hint: { color: colors.faint, fontSize: 12, lineHeight: 17 },
  input: {
    color: colors.text,
    fontSize: 15,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  mono: { fontFamily: "Menlo", fontSize: 13 },
  link: { color: colors.accent, fontSize: 14 },
  conflict: { gap: 10, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: "rgba(180,83,9,0.4)", backgroundColor: "rgba(69,26,3,0.35)" },
  conflictText: { color: "#fde68a", fontSize: 13, lineHeight: 18 },
  primary: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
