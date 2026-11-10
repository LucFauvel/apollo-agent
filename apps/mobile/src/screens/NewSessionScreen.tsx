import type { BotId, ProjectId, Session } from "@apollo/contracts";
import { useMemo, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApollo } from "../AppState.tsx";
import { BlobAvatar } from "../BlobAvatar.tsx";
import { errorMessage } from "../connection.ts";
import { CheckIcon, FolderKanbanIcon } from "../icons.tsx";
import { useKeyboardInset } from "../motion.tsx";
import { colors } from "../theme.ts";
import { Field, Input, PrimaryButton } from "./ProjectsScreen.tsx";

/** A worker session for a bot, with the bot's default worker, optionally in one of its projects. */
export function NewSessionScreen({
  botId,
  projectId: initialProject = null,
  onBack,
  onCreated,
}: {
  botId: BotId;
  projectId?: ProjectId | null | undefined;
  onBack: () => void;
  onCreated: (session: Session) => void;
}) {
  const { state, connection } = useApollo();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset(insets.bottom);
  const bot = state.bots.get(botId);
  const projects = useMemo(
    () =>
      [...state.projects.values()]
        .filter((p) => p.botId === botId && (p.status === "active" || p.id === initialProject))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [state.projects, botId, initialProject],
  );
  const workspaceOf = (id: ProjectId | null) => (id ? state.projects.get(id)?.cwd : null) ?? bot?.cwd ?? "";
  const [projectId, setProjectId] = useState<ProjectId | null>(initialProject);
  const [cwd, setCwd] = useState(() => workspaceOf(initialProject));
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const pick = (next: ProjectId | null) => {
    // The workspace follows the project, unless it was changed by hand.
    if (cwd === workspaceOf(projectId)) setCwd(workspaceOf(next));
    setProjectId(next);
  };

  const create = () => {
    if (!bot) return;
    setSaving(true);
    setError(null);
    connection
      .rpc((c) =>
        c["sessions.create"]({
          botId: bot.id,
          // Empty: the server names it from the first message.
          title: title.trim(),
          provider: bot.defaultWorker,
          cwd,
          ...(worktree ? { isolation: "worktree" as const } : {}),
          ...(prompt.trim() ? { prompt } : {}),
          ...(projectId ? { projectId } : {}),
        }),
      )
      .then(onCreated)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  const worker = bot ? [bot.defaultWorker.provider, bot.defaultWorker.model].filter(Boolean).join(" · ") : "";

  return (
    <Animated.View style={[styles.screen, { paddingBottom: keyboard }]}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        {bot ? <BlobAvatar avatar={bot.avatar} size={28} /> : null}
        <Text style={styles.title} numberOfLines={1}>
          New session{bot ? ` · ${bot.name}` : ""}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
        <Text style={styles.hint}>A worker session for {bot?.name ?? "the bot"}, outside the orchestrator. It runs {worker}.</Text>
        <Field label="First message">
          <Input value={prompt} onChangeText={setPrompt} multiline autoFocus placeholder="What should it do?" style={{ minHeight: 110, textAlignVertical: "top" }} />
        </Field>
        <Field label="Title" hint="Empty: named from the first message.">
          <Input value={title} onChangeText={setTitle} placeholder="Optional" />
        </Field>
        {projects.length > 0 ? (
          <Field label="Project" hint="A session in a project gets its context and saves what it learns there.">
            <View style={styles.card}>
              {[null, ...projects].map((p, i) => {
                const id = p?.id ?? null;
                const selected = id === projectId;
                return (
                  <Pressable key={id ?? "none"} onPress={() => pick(id)} style={({ pressed }) => [styles.option, i > 0 && styles.optionBorder, pressed && { opacity: 0.55 }]}>
                    {p ? <FolderKanbanIcon size={15} color={colors.faint} /> : <View style={{ width: 15 }} />}
                    <Text style={[styles.optionText, !p && { color: colors.muted }]} numberOfLines={1}>
                      {p ? p.name : "None"}
                    </Text>
                    {selected ? <CheckIcon size={16} color={colors.accent} /> : null}
                  </Pressable>
                );
              })}
            </View>
          </Field>
        ) : null}
        <Field label="Workspace">
          <Input value={cwd} onChangeText={setCwd} mono />
        </Field>
        <View style={styles.toggle}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleTitle}>Own git worktree</Text>
            <Text style={styles.hint}>Works on its own branch, so it doesn't touch the workspace's checkout. The workspace must be a git repository.</Text>
          </View>
          <Switch value={worktree} onValueChange={setWorktree} trackColor={{ true: colors.accent }} />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <PrimaryButton label="Start session" onPress={create} busy={saving} disabled={!bot || !cwd.trim()} />
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
  back: { color: colors.accent, fontSize: 16, marginRight: 4 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600", flex: 1 },
  body: { padding: 16, gap: 16, paddingBottom: 40 },
  hint: { color: colors.faint, fontSize: 12, lineHeight: 17 },
  card: { backgroundColor: colors.panelSoft, borderRadius: 12, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  option: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 11 },
  optionBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  optionText: { color: colors.textSoft, fontSize: 15, flex: 1 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 12 },
  toggleTitle: { color: colors.textSoft, fontSize: 15, marginBottom: 2 },
  error: { color: colors.red, fontSize: 13 },
});
