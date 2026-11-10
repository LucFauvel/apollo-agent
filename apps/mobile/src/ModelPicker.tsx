import type { ModelOption, ProviderKind, Session } from "@apollo/contracts";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApollo } from "./AppState.tsx";
import { type Connection, errorMessage } from "./connection.ts";
import { CheckIcon, ChevronDownIcon } from "./icons.tsx";
import { colors } from "./theme.ts";

const requests = new WeakMap<Connection, Map<ProviderKind, Promise<ReadonlyArray<ModelOption>>>>();

const load = (connection: Connection, provider: ProviderKind) => {
  let byProvider = requests.get(connection);
  if (!byProvider) requests.set(connection, (byProvider = new Map()));
  let request = byProvider.get(provider);
  if (!request) {
    request = connection.rpc((c) => c["providers.models"]({ provider }));
    request.catch(() => byProvider.delete(provider));
    byProvider.set(provider, request);
  }
  return request;
};

type ModelsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly models: ReadonlyArray<ModelOption> }
  | { readonly status: "error"; readonly error: string };

const useModels = (provider: ProviderKind): ModelsState => {
  const { connection } = useApollo();
  const [state, setState] = useState<ModelsState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    load(connection, provider).then(
      (models) => !cancelled && setState({ status: "ready", models }),
      (error) => !cancelled && setState({ status: "error", error: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [connection, provider]);
  return state;
};

const effectiveModel = (models: ReadonlyArray<ModelOption>, model: string | null) =>
  models.find((m) => m.id === model) ?? (model === null ? models.find((m) => m.isDefault) : undefined);

const effortLabel = (effort: string) => effort.charAt(0).toUpperCase() + effort.slice(1);

const providerName = (provider: ProviderKind) =>
  provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider === "llamacpp" ? "Local model" : provider;

/** The model indicator in the message box; tapping it picks the session's model and effort. */
export function ModelMenu({ session }: { session: Session }) {
  const { connection } = useApollo();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useModels(session.provider);
  const models = state.status === "ready" ? state.models : [];
  const current = effectiveModel(models, session.model);
  const label = current?.label ?? session.model ?? providerName(session.provider);
  const efforts = [...new Set([...(current?.efforts ?? []), ...(session.effort ? [session.effort] : [])])];
  const fallback = models.find((m) => m.isDefault);

  const update = (model: string | null, effort: string | null) => {
    setError(null);
    connection
      .rpc((c) => c["sessions.update"]({ sessionId: session.id, model, effort }))
      .catch((e) => setError(errorMessage(e)));
  };
  const pickModel = (model: string | null) => {
    const next = effectiveModel(models, model);
    update(model, session.effort !== null && next?.efforts.includes(session.effort) ? session.effort : null);
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
        onPress={() => setOpen(true)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`Model: ${label}${session.effort ? `, ${session.effort} effort` : ""}. Change`}
        style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
      >
        <Text style={styles.chipModel} numberOfLines={1}>
          {label}
        </Text>
        {session.effort ? <Text style={styles.chipEffort}>{effortLabel(session.effort)}</Text> : null}
        <ChevronDownIcon size={12} color={colors.faint} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Close" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <Text style={styles.heading}>{providerName(session.provider)} model</Text>
          <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 2 }}>
            {state.status === "loading" ? (
              <Text style={styles.note}>Loading models…</Text>
            ) : state.status === "error" ? (
              <Text style={styles.note}>Could not list models ({state.error}).</Text>
            ) : (
              <>
                {row("default", session.model === null, () => pickModel(null), `Default${fallback ? ` (${fallback.label})` : ""}`)}
                {models.map((m) => row(m.id, session.model === m.id, () => pickModel(m.id), m.label, m.description || undefined))}
                {session.model !== null && !models.some((m) => m.id === session.model)
                  ? row(session.model, true, () => setOpen(false), session.model)
                  : null}
              </>
            )}
          </ScrollView>
          {efforts.length > 0 ? (
            <>
              <Text style={[styles.heading, { marginTop: 12 }]}>Effort</Text>
              <View style={styles.efforts}>
                {[null, ...efforts].map((e) => {
                  const selected = session.effort === e;
                  return (
                    <Pressable
                      key={e ?? "default"}
                      onPress={() => update(session.model, e)}
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
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Text style={styles.hint}>
            {session.status === "running" || session.status === "starting" || session.status === "waiting-approval"
              ? "Applies once the current turn ends."
              : "Applies from the next message."}
          </Text>
        </View>
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
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.panel,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingTop: 14,
  },
  heading: { color: colors.faint, fontSize: 12, fontWeight: "500", paddingHorizontal: 8, marginBottom: 6 },
  note: { color: colors.faint, fontSize: 13, paddingHorizontal: 8, paddingVertical: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9 },
  rowOn: { backgroundColor: "rgba(63,63,70,0.5)" },
  rowTitle: { color: colors.textSoft, fontSize: 14 },
  rowDetail: { color: colors.faint, fontSize: 12, marginTop: 1 },
  efforts: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 6 },
  effort: { borderRadius: 8, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, paddingVertical: 6 },
  effortOn: { borderColor: "#52525b", backgroundColor: "#27272a" },
  effortText: { color: colors.muted, fontSize: 13 },
  error: { color: colors.red, fontSize: 12, paddingHorizontal: 8, marginTop: 8 },
  hint: { color: "#52525b", fontSize: 11, paddingHorizontal: 8, marginTop: 10 },
});
