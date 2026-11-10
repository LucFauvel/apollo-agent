import { meterTone, percentLeft, relativeTime } from "@apollo/client";
import { headlineMeter, type UsageLimits } from "@apollo/contracts";
import { Alert, Pressable, StyleSheet, Text } from "react-native";
import Svg, { Rect } from "react-native-svg";
import { colors } from "./theme.ts";

const TONE = { critical: colors.red, warning: colors.amber, normal: colors.faint } as const;

const providerName = (provider: string) => (provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider);

/**
 * How much of the provider account's plan is left: the headline meter as a small bar and a
 * percentage; a tap lists every meter. Shared by every session on the account.
 */
export function UsageMeter({ limits, provider }: { limits: UsageLimits; provider: string }) {
  const headline = headlineMeter(limits.meters);
  if (!headline) return null;
  const left = percentLeft(headline);
  const color = TONE[meterTone(headline)];
  const name = providerName(provider);
  const details = () => {
    const now = Date.now();
    const lines = limits.meters.map(
      (m) => `${m.label}: ${percentLeft(m)}% left${m.resetsAt !== null ? `, resets ${relativeTime(m.resetsAt, now)}` : ""}`,
    );
    Alert.alert(`${name} usage left`, `${lines.join("\n")}\n\nFor the whole ${name} account, as it reported ${relativeTime(limits.at, now)}.`);
  };
  return (
    <Pressable onPress={details} hitSlop={8} accessibilityLabel={`${name} usage: ${left}% left (${headline.label})`} style={styles.meter}>
      <Svg width={14} height={10} viewBox="0 0 14 10">
        <Rect x={0.75} y={0.75} width={12.5} height={8.5} rx={2} fill="none" stroke={color} strokeOpacity={0.4} strokeWidth={1.5} />
        <Rect x={2.5} y={2.5} width={9 * (left / 100)} height={5} rx={1} fill={color} />
      </Svg>
      <Text style={[styles.text, { color }]}>{left}% left</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  meter: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  text: { fontSize: 12, fontVariant: ["tabular-nums"] },
});
