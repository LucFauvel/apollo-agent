import {
  ACTIVITY,
  type ActivityBlock,
  type ActivityCategory,
  type ActivityStep,
  activityRunning,
  bySubagent,
  describeStep,
  errorCount,
  firstLine,
  stepCategory,
  summarizeActivity,
  stepTitle,
  toolSummary,
} from "@apollo/client";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  AppWindowIcon,
  BotIcon,
  ChevronRightIcon,
  FilePenIcon,
  FileTextIcon,
  GitBranchIcon,
  GlobeIcon,
  type Icon,
  KeyRoundIcon,
  LayoutTemplateIcon,
  LightbulbIcon,
  LoaderIcon,
  NetworkIcon,
  PlugIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
  XIcon,
} from "./icons.tsx";
import { Pulse, Spin, Turn, useToggle } from "./motion.tsx";
import { colors } from "./theme.ts";

/**
 * Thoughts and tool calls, drawn as the desktop app draws them (apps/web Activity.tsx):
 * one collapsed line per run of steps, and a timeline of steps when opened.
 */

const ICON: Record<ActivityCategory, Icon> = {
  thought: LightbulbIcon,
  agent: BotIcon,
  command: SquareTerminalIcon,
  read: FileTextIcon,
  edit: FilePenIcon,
  search: SearchIcon,
  web: GlobeIcon,
  browser: AppWindowIcon,
  visual: LayoutTemplateIcon,
  secret: KeyRoundIcon,
  apollo: NetworkIcon,
  git: GitBranchIcon,
  connector: PlugIcon,
  tool: WrenchIcon,
};

/** A hex color at some opacity (`#c4b5fd` → `#c4b5fd1a`). */
const alpha = (hex: string, a: number) =>
  `${hex}${Math.round(a * 255)
    .toString(16)
    .padStart(2, "0")}`;

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";
const VIOLET_TEXT = "rgba(221,214,254,0.9)"; // violet-200/90
const RED = "#fca5a5"; // red-300

function StepIcon({ category, pending, error }: { category: ActivityCategory; pending: boolean; error: boolean }) {
  const tint = error ? RED : ACTIVITY[category].color;
  const Glyph = ICON[category];
  return (
    <View
      style={[
        styles.stepIcon,
        error
          ? { backgroundColor: "rgba(239,68,68,0.1)", borderColor: "rgba(239,68,68,0.3)" }
          : { backgroundColor: alpha(ACTIVITY[category].color, 0.1), borderColor: alpha(ACTIVITY[category].color, 0.25) },
      ]}
    >
      {pending ? (
        <Spin>
          <LoaderIcon size={12} color={tint} />
        </Spin>
      ) : error ? (
        <XIcon size={12} color={tint} />
      ) : (
        <Glyph size={12} color={tint} />
      )}
    </View>
  );
}

function StepRow({ step, last, nested }: { step: ActivityStep; last: boolean; nested: boolean }) {
  const [open, toggle] = useToggle();
  const category = stepCategory(step);
  const pending = step.kind === "tool" && step.output === null;
  const error = step.kind === "tool" && step.isError;
  const detail = step.kind === "reasoning" ? step.text : step.output;
  const expandable = Boolean(detail?.trim());

  return (
    <View style={[styles.step, nested && { marginLeft: 20 }]}>
      {!last ? <View style={styles.rail} /> : null}
      <StepIcon category={category} pending={pending} error={error} />
      <View style={styles.stepBody}>
        <Pressable disabled={!expandable} onPress={toggle} hitSlop={6} style={styles.stepHeader}>
          {step.kind === "reasoning" ? (
            <>
              <Text style={[styles.stepName, { color: VIOLET_TEXT }]}>Thought</Text>
              <Text style={styles.thoughtPreview} numberOfLines={1}>
                {open ? "" : firstLine(step.text)}
              </Text>
            </>
          ) : (
            <>
              <Text style={[styles.stepName, error && { color: RED }]} numberOfLines={1}>
                {stepTitle(step)}
              </Text>
              {pending ? (
                <Pulse style={{ flex: 1 }}>
                  <Text style={[styles.toolSummary, { color: colors.muted }]} numberOfLines={1}>
                    {toolSummary(step.name, step.summary)}
                  </Text>
                </Pulse>
              ) : (
                <Text style={styles.toolSummary} numberOfLines={1}>
                  {toolSummary(step.name, step.summary)}
                </Text>
              )}
            </>
          )}
          {expandable ? (
            <Turn open={open}>
              <ChevronRightIcon size={14} color="#52525b" />
            </Turn>
          ) : null}
        </Pressable>
        {/* Outside the tap target, so long output can scroll sideways without closing it. */}
        {open ? (
          step.kind === "reasoning" ? (
            <View style={styles.thought}>
              <Text style={styles.thoughtText} selectable>
                {step.text}
              </Text>
            </View>
          ) : (
            <ScrollView
              style={[styles.output, error && styles.outputError]}
              contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
              nestedScrollEnabled
            >
              <Text style={[styles.outputText, error && { color: "rgba(254,202,202,0.8)" }]} selectable>
                {detail?.slice(0, 8000)}
              </Text>
            </ScrollView>
          )
        ) : null}
      </View>
    </View>
  );
}

/**
 * Thoughts and tool calls between two messages. Collapsed to a one-line
 * summary; while the agent is still in it, the line shows the current step.
 */
export function ActivityGroup({ block, live }: { block: ActivityBlock; live: boolean }) {
  const [open, toggle] = useToggle();
  const { steps } = block;
  const { text, categories } = summarizeActivity(steps);
  const running = activityRunning(block, live);
  const errors = steps.filter((s) => s.kind === "tool" && s.isError).length;
  const current = steps.at(-1)!;

  return (
    <View>
      <Pressable onPress={toggle} style={[styles.group, open && styles.groupOpen]}>
        <View style={styles.stack}>
          {categories.slice(0, 4).map((c, i) => {
            const Glyph = ICON[c];
            return (
              <View key={c} style={[styles.stackIcon, i > 0 && { marginLeft: -6 }]}>
                <Glyph size={12} color={ACTIVITY[c].color} />
              </View>
            );
          })}
        </View>
        {running && !open ? (
          <View style={styles.live}>
            <Spin>
              <LoaderIcon size={12} color={colors.muted} />
            </Spin>
            <Pulse style={{ flex: 1 }}>
              <Text style={styles.liveText} numberOfLines={1}>
                {describeStep(current)}
              </Text>
            </Pulse>
          </View>
        ) : (
          <Text style={styles.summary} numberOfLines={1}>
            {text}
          </Text>
        )}
        {errors > 0 ? (
          <View style={styles.errors}>
            <Text style={styles.errorsText}>{errorCount(errors)}</Text>
          </View>
        ) : null}
        <Text style={styles.count}>{steps.length}</Text>
        <Turn open={open}>
          <ChevronRightIcon size={14} color={colors.faint} />
        </Turn>
      </Pressable>
      {open ? (
        <View style={styles.steps}>
          {steps.map((step, i) => (
            <StepRow key={step.key} step={step} last={i === steps.length - 1} nested={bySubagent(step, steps)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "transparent",
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginHorizontal: -10,
  },
  groupOpen: { borderColor: colors.border, backgroundColor: "rgba(24,24,27,0.6)" },
  stack: { flexDirection: "row" },
  stackIcon: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.panel,
    borderWidth: 2,
    borderColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  live: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  liveText: { color: colors.textSoft, fontSize: 12.5 },
  summary: { flex: 1, color: colors.muted, fontSize: 12.5 },
  errors: { backgroundColor: "rgba(239,68,68,0.15)", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  errorsText: { color: RED, fontSize: 10.5, fontWeight: "600" },
  count: { color: "#52525b", fontSize: 10.5, fontVariant: ["tabular-nums"] },
  steps: { paddingTop: 10 },
  step: { flexDirection: "row", gap: 10 },
  rail: { position: "absolute", top: 24, bottom: 0, left: 11.5, width: 1, backgroundColor: colors.border },
  stepIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBody: { flex: 1, minWidth: 0, paddingBottom: 8 },
  stepHeader: { height: 24, flexDirection: "row", alignItems: "center", gap: 8 },
  stepName: { color: colors.text, fontSize: 12.5, fontWeight: "500", flexShrink: 0, maxWidth: "60%" },
  thoughtPreview: { flex: 1, color: colors.faint, fontSize: 12.5, fontStyle: "italic" },
  toolSummary: { flex: 1, color: colors.faint, fontSize: 11, fontFamily: MONO },
  thought: { marginTop: 4, borderLeftWidth: 2, borderLeftColor: "rgba(139,92,246,0.2)", paddingLeft: 12 },
  thoughtText: { color: colors.muted, fontSize: 12.5, lineHeight: 19, fontStyle: "italic" },
  output: {
    marginTop: 4,
    maxHeight: 288,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(24,24,27,0.6)",
  },
  outputError: { borderColor: "rgba(127,29,29,0.5)", backgroundColor: "rgba(69,10,10,0.2)" },
  outputText: { color: colors.muted, fontSize: 11, lineHeight: 17, fontFamily: MONO },
});
