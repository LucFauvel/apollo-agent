import { downloadPercent, effectiveModel, makeChoiceSync, splitModelId, withEffort, withModel } from "@apollo/client";
import { type Bot, isDownloaded, type ModelOption, type ProviderKind, type RuntimeMode, type Session } from "@apollo/contracts";
import { useEffect, useMemo, useReducer, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApollo } from "./AppState.tsx";
import { errorMessage } from "./connection.ts";
import { CheckIcon, ChevronDownIcon } from "./icons.tsx";
import { colors } from "./theme.ts";

type ModelsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly models: ReadonlyArray<ModelOption> }
  | { readonly status: "error"; readonly error: string };

/** The provider's models, fetched again whenever `refresh` changes; the last list stays shown meanwhile. */
const useModels = (provider: ProviderKind, refresh: string): ModelsState => {
  const { connection } = useApollo();
  const [state, setState] = useState<ModelsState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    connection
      .rpc((c) => c["providers.models"]({ provider }))
      .then(
        (models) => !cancelled && setState({ status: "ready", models }),
        (error) => !cancelled && setState((s) => (s.status === "ready" ? s : { status: "error", error: errorMessage(error) })),
      );
    return () => {
      cancelled = true;
    };
  }, [connection, provider, refresh]);
  return state;
};

const effortLabel = (effort: string) => effort.charAt(0).toUpperCase() + effort.slice(1);

const providerName = (provider: ProviderKind) =>
  provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider === "llamacpp" ? "Local model" : provider;

const PERMISSIONS: ReadonlyArray<{ value: RuntimeMode; label: string; detail: string }> = [
  { value: "approval-required", label: "Ask first", detail: "Prompts before risky actions" },
  { value: "auto", label: "Auto", detail: "A reviewer model decides; asks you when unsure" },
  { value: "full-access", label: "Full access", detail: "Never prompts" },
];

/** The model indicator in the message box; tapping it picks the session's model, effort and permissions. */
export function ModelMenu({ session, bot }: { session: Session; bot: Bot | undefined }) {
  const { connection, state: app, loadLocalModels } = useApollo();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState<string | null>(null);
  const [mode, setMode] = useState<{ value: RuntimeMode | null } | null>(null);
  const local = session.provider === "llamacpp" ? app.localModels : null;
  const downloaded = local?.models.filter(isDownloaded).map((m) => m.id).join("\n") ?? "";
  const state = useModels(session.provider, `${opened}\n${downloaded}`);

  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const sync = useMemo(
    () =>
      makeChoiceSync({
        send: (choice) =>
          connection
            .rpc((c) => c["sessions.update"]({ sessionId: session.id, model: choice.model, effort: choice.effort }))
            .then((saved) => ({ model: saved.model, effort: saved.effort })),
        onChange: rerender,
        onError: (e) => setError(errorMessage(e)),
      }),
    [connection, session.id],
  );
  useEffect(() => sync.sessionChanged({ model: session.model, effort: session.effort }), [sync, session.model, session.effort]);
  useEffect(() => {
    if (mode && mode.value === session.runtimeMode) setMode(null);
  }, [mode, session.runtimeMode]);
  useEffect(() => {
    if (open && session.provider === "llamacpp" && !app.localModels) loadLocalModels().catch(() => {});
  }, [open, session.provider, app.localModels, loadLocalModels]);

  const shown = sync.shown({ model: session.model, effort: session.effort });
  const models = state.status === "ready" ? state.models : [];
  const pending = (local?.models ?? []).filter((d) => !isDownloaded(d) && !models.some((m) => m.id === d.id));
  const current = effectiveModel(models, shown.model);
  const label = current?.label ?? shown.model ?? providerName(session.provider);
  const efforts = [...new Set([...(current?.efforts ?? []), ...(shown.effort ? [shown.effort] : [])])];
  const fallback = models.find((m) => m.isDefault);
  const known = shown.model === null || models.some((m) => m.id === shown.model) || pending.some((m) => m.id === shown.model);
  const runtimeMode = mode ? mode.value : session.runtimeMode;
  const botMode = PERMISSIONS.find((p) => p.value === bot?.runtimeMode);

  const pick = (choice: Parameters<typeof sync.pick>[0]) => {
    setError(null);
    sync.pick(choice);
  };
  const pickModel = (model: string | null) => {
    setCustom(null);
    pick(withModel(models, shown, model));
  };
  const saveCustom = () => {
    if (custom === null) return;
    const model = custom.trim() || null;
    setCustom(null);
    if (model !== shown.model) pick(withModel(models, shown, model));
  };
  const pickMode = (value: RuntimeMode | null) => {
    setError(null);
    setMode({ value });
    connection
      .rpc((c) => c["sessions.update"]({ sessionId: session.id, runtimeMode: value }))
      .catch((e) => {
        setMode(null);
        setError(errorMessage(e));
      });
  };
  const close = () => {
    saveCustom();
    setOpen(false);
  };

  const row = (key: string, selected: boolean, onPress: () => void, title: string, detail?: string) => (
    <Pressable
      key={key}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.row, (selected || pressed) && styles.rowOn]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.rowTitle, selected && { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={styles.rowDetail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {selected ? <CheckIcon size={16} color={colors.muted} /> : null}
    </Pressable>
  );

  return (
    <>
      <Pressable
        onPress={() => {
          setOpened((n) => n + 1);
          setOpen(true);
        }}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`Model: ${label}${shown.effort ? `, ${shown.effort} effort` : ""}. Change`}
        style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
      >
        <Text style={styles.chipModel} numberOfLines={1}>
          {label}
        </Text>
        {shown.effort ? <Text style={styles.chipEffort}>{effortLabel(shown.effort)}</Text> : null}
        <ChevronDownIcon size={12} color={colors.faint} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Close" />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.sheetWrap} pointerEvents="box-none">
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 2 }}>
              <Text style={styles.heading}>{providerName(session.provider)} model</Text>
              {state.status === "loading" ? (
                <Text style={styles.note}>Loading models…</Text>
              ) : state.status === "error" && pending.length === 0 ? (
                <Text style={styles.note}>Could not list models ({state.error}). Type a model id below.</Text>
              ) : (
                <>
                  {row("default", shown.model === null, () => pickModel(null), `Default${fallback ? ` (${fallback.label})` : ""}`)}
                  {models.map((m) => row(m.id, shown.model === m.id, () => pickModel(m.id), m.label, m.description || undefined))}
                  {pending.map((m) => {
                    const { name, quant } = splitModelId(m.id);
                    return row(m.id, shown.model === m.id, () => pickModel(m.id), `${name} ${quant ?? ""}`.trim(), `Downloading ${downloadPercent(m)}%`);
                  })}
                </>
              )}
              {custom !== null ? (
                <TextInput
                  style={styles.customInput}
                  value={custom}
                  onChangeText={setCustom}
                  onSubmitEditing={saveCustom}
                  placeholder="model id (empty for the default)"
                  placeholderTextColor={colors.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  returnKeyType="done"
                />
              ) : (
                row(
                  "custom",
                  !known,
                  () => setCustom(known ? "" : (shown.model ?? "")),
                  known ? "Other…" : (shown.model ?? ""),
                  known ? "Type a model id" : "Custom model id · tap to edit",
                )
              )}
              {efforts.length > 0 ? (
                <>
                  <Text style={[styles.heading, styles.section]}>Effort</Text>
                  <View style={styles.efforts}>
                    {[null, ...efforts].map((e) => {
                      const selected = shown.effort === e;
                      return (
                        <Pressable
                          key={e ?? "default"}
                          onPress={() => pick(withEffort(shown, e))}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          style={({ pressed }) => [styles.effort, (selected || pressed) && styles.effortOn]}
                        >
                          <Text style={[styles.effortText, selected && { color: colors.text }]}>
                            {e === null ? `Default${current?.defaultEffort ? ` (${effortLabel(current.defaultEffort)})` : ""}` : effortLabel(e)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              ) : null}
              <Text style={[styles.heading, styles.section]}>Permissions</Text>
              {row("inherit", runtimeMode === null, () => pickMode(null), "Same as bot", botMode?.label)}
              {PERMISSIONS.map((p) => row(p.value, runtimeMode === p.value, () => pickMode(p.value), p.label, p.detail))}
            </ScrollView>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Text style={styles.hint}>
              {session.status === "running" || session.status === "starting" || session.status === "waiting-approval"
                ? "Changes apply once the current turn ends."
                : "Changes apply from the next message."}
            </Text>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    maxWidth: "100%",
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
  },
  chipPressed: {
    backgroundColor: "rgba(255,255,255,0.05)",
    shadowColor: "#fff",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  chipModel: { color: colors.faint, fontSize: 12, flexShrink: 1 },
  chipEffort: { color: "#52525b", fontSize: 12 },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)" },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    maxHeight: "80%",
    backgroundColor: colors.panel,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingTop: 14,
  },
  heading: { color: colors.faint, fontSize: 12, fontWeight: "500", paddingHorizontal: 8, marginBottom: 4 },
  section: { marginTop: 14 },
  note: { color: colors.faint, fontSize: 13, paddingHorizontal: 8, paddingVertical: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9 },
  rowOn: { backgroundColor: "rgba(63,63,70,0.5)" },
  rowTitle: { color: colors.textSoft, fontSize: 14 },
  rowDetail: { color: colors.faint, fontSize: 12, marginTop: 1 },
  customInput: {
    color: colors.text,
    backgroundColor: colors.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  efforts: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 6 },
  effort: { borderRadius: 8, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, paddingVertical: 6 },
  effortOn: { borderColor: "#52525b", backgroundColor: "#27272a" },
  effortText: { color: colors.muted, fontSize: 13 },
  error: { color: colors.red, fontSize: 12, paddingHorizontal: 8, marginTop: 8 },
  hint: { color: "#52525b", fontSize: 11, paddingHorizontal: 8, marginTop: 10 },
});
