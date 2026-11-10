import { billableTokens, formatUsd, type Usage } from "@apollo/contracts";

/** 950 → "950", 12_300 → "12.3k", 4_200_000 → "4.2M". */
export const formatTokens = (n: number): string =>
  n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`;

export const formatCost = formatUsd;

/** "12.3k tokens · $0.42" (cost only when the provider reported one). */
export const formatUsage = (usage: Usage): string =>
  [`${formatTokens(billableTokens(usage))} tokens`, usage.costUsd > 0 ? formatCost(usage.costUsd) : null]
    .filter(Boolean)
    .join(" · ");

export const usageTitle = (usage: Usage): string =>
  `${usage.inputTokens.toLocaleString()} input · ${usage.cachedInputTokens.toLocaleString()} cached · ${usage.outputTokens.toLocaleString()} output` +
  (usage.costUsd > 0 ? ` · ~$${usage.costUsd.toFixed(4)} (estimate)` : "");

export { relativeTime } from "@apollo/client";
