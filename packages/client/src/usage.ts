import type { UsageMeter } from "@apollo/contracts";

/** "in 12 min", "3 h ago", "in 2 d". */
export const relativeTime = (at: number, now: number) => {
  const diff = at - now;
  const abs = Math.abs(diff);
  const text =
    abs < 60_000
      ? "less than a minute"
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)} min`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)} h`
          : `${Math.round(abs / 86_400_000)} d`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
};

export const percentLeft = (m: UsageMeter) => Math.max(0, Math.min(100, Math.round(100 - m.usedPercent)));

/** A meter's grading: the provider's own when it gives one, else how full it is. */
export const meterTone = (m: UsageMeter): "critical" | "warning" | "normal" =>
  m.severity !== null
    ? m.severity === "critical"
      ? "critical"
      : m.severity === "warning"
        ? "warning"
        : "normal"
    : m.usedPercent >= 90
      ? "critical"
      : m.usedPercent >= 75
        ? "warning"
        : "normal";
