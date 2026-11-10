import { headlineMeter } from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import { claudeLimitsFromUsage, claudeUsageMeters } from "../src/ClaudeProvider.ts";

describe("claudeUsageMeters", () => {
  it("takes the server's rows as sent, with their grading and headline pick", () => {
    // Trimmed from a real get_usage reply (a Team plan).
    const meters = claudeUsageMeters({
      five_hour: { utilization: 44, resets_at: "2026-11-10T17:20:00.857995+00:00" },
      seven_day: { utilization: 36, resets_at: "2026-11-13T08:00:00.858019+00:00" },
      extra_usage: { is_enabled: true, monthly_limit: 100000, used_credits: 2500, utilization: null, currency: "CAD" },
      limits: [
        { kind: "session", group: "session", percent: 44, severity: "normal", resets_at: "2026-11-10T17:20:00.857995+00:00", scope: null, is_active: true },
        { kind: "weekly_all", group: "weekly", percent: 36, severity: "warning", resets_at: "2026-11-13T08:00:00.858019+00:00", scope: null, is_active: false },
        { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: null, scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
      ],
    });
    expect(meters).toEqual([
      { label: "Session", usedPercent: 44, resetsAt: Date.parse("2026-11-10T17:20:00.857Z"), severity: "normal", headline: true },
      { label: "Weekly", usedPercent: 36, resetsAt: Date.parse("2026-11-13T08:00:00.858Z"), severity: "warning", headline: false },
      { label: "Weekly · Fable", usedPercent: 0, resetsAt: null, severity: "normal", headline: false },
      { label: "Extra usage (monthly)", usedPercent: 2.5, resetsAt: null, severity: null, headline: false },
    ]);
    expect(headlineMeter(meters)?.label).toBe("Session");
  });

  it("falls back to the named windows on a reply without rows, skipping unknown ones", () => {
    const meters = claudeUsageMeters({
      five_hour: { utilization: 80, resets_at: null },
      seven_day: { utilization: null, resets_at: null },
      seven_day_opus: null,
      model_scoped: [{ display_name: "Fable", utilization: 91, resets_at: null }],
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    });
    expect(meters.map((m) => [m.label, m.usedPercent])).toEqual([
      ["Session", 80],
      ["Weekly · Fable", 91],
    ]);
    // No pick from the server: the fullest meter.
    expect(headlineMeter(meters)?.label).toBe("Weekly · Fable");
  });

  it("has no meters when Claude Code reports none", () => {
    expect(claudeUsageMeters(null)).toEqual([]);
    expect(claudeUsageMeters({ limits: [] })).toEqual([]);
  });

  it("reports an empty set when plan limits do not apply, so saved meters are cleared", () => {
    // After a switch from a subscription to an API key, Claude Code says limits are unavailable.
    expect(claudeLimitsFromUsage({ rate_limits_available: false, rate_limits: null })).toEqual([]);
    expect(
      claudeLimitsFromUsage({ rate_limits_available: true, rate_limits: { limits: [{ group: "session", percent: 5, severity: "normal", is_active: true }] } }),
    ).toEqual([{ label: "Session", usedPercent: 5, resetsAt: null, severity: "normal", headline: true }]);
  });
});
