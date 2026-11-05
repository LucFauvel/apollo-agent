import { describe, expect, it } from "@effect/vitest";
import { graceMs, nextRun, parseDuration, parseSpec, parseTimeOfDay, shortestGap, type Spec, upcoming } from "./Spec.ts";

const TZ = "America/Toronto";
// Wednesday 2026-11-04 10:00 in Toronto (UTC-5).
const NOW = Date.parse("2026-11-04T15:00:00Z");

const spec = (text: string, tz = TZ): Spec => {
  const result = parseSpec(text, tz, NOW);
  if (!result.ok) throw new Error(result.error);
  return result.spec;
};
const error = (text: string) => {
  const result = parseSpec(text, TZ, NOW);
  if (result.ok) throw new Error(`expected "${text}" to be rejected`);
  return result.error;
};
const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

describe("schedule specs", () => {
  it("reads durations and times of day", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("1h30m")).toBe(90 * 60_000);
    expect(parseDuration("2 hours")).toBe(2 * 3_600_000);
    expect(parseDuration("hour")).toBe(3_600_000);
    expect(parseDuration("soon")).toBeNull();
    expect(parseTimeOfDay("9am")).toEqual([9, 0]);
    expect(parseTimeOfDay("12am")).toEqual([0, 0]);
    expect(parseTimeOfDay("9:30 pm")).toEqual([21, 30]);
    expect(parseTimeOfDay("21:05")).toEqual([21, 5]);
    expect(parseTimeOfDay("noon")).toEqual([12, 0]);
    expect(parseTimeOfDay("9")).toBeNull();
    expect(parseTimeOfDay("13pm")).toBeNull();
  });

  it("stores relative one-shots as the wall-clock time they name", () => {
    const s = spec("in 30m");
    expect(s).toMatchObject({ kind: "once", spec: "2026-11-04 10:30" });
    expect(iso(nextRun(s, NOW, NOW))).toBe("2026-11-04T15:30:00.000Z");
    // Re-reading the stored spec later does not move it.
    const reread = parseSpec(s.spec, TZ, NOW + 86_400_000);
    expect(reread.ok && reread.spec.kind === "once" && reread.spec.at).toBe(NOW + 30 * 60_000);
    expect(nextRun(s, NOW + 31 * 60_000, NOW)).toBeNull();
  });

  it("reads absolute and day-relative one-shots in the schedule's zone", () => {
    expect(iso(spec("tomorrow at 9am").kind === "once" ? (spec("tomorrow at 9am") as { at: number }).at : null)).toBe(
      "2026-11-05T14:00:00.000Z",
    );
    expect((spec("2026-12-01 09:00") as { at: number }).at).toBe(Date.parse("2026-12-01T14:00:00Z"));
    expect((spec("2026-12-01 09:00", "Europe/Paris") as { at: number }).at).toBe(Date.parse("2026-12-01T08:00:00Z"));
    // "at 9am" when it is already 10am means tomorrow; "at 5pm" means today.
    expect((spec("at 9am") as { at: number }).at).toBe(Date.parse("2026-11-05T14:00:00Z"));
    expect((spec("at 5pm") as { at: number }).at).toBe(Date.parse("2026-11-04T22:00:00Z"));
    expect(spec("today at 5pm").description).toBe("Once, Wed, Nov 4, 2026, 5:00 PM");
  });

  it("reads intervals", () => {
    expect(spec("every 30m")).toMatchObject({ kind: "interval", everyMs: 1_800_000, description: "Every 30 minutes" });
    expect(spec("every hour")).toMatchObject({ kind: "interval", everyMs: 3_600_000, spec: "every 1 hour" });
    expect(spec("2h")).toMatchObject({ kind: "interval", description: "Every 2 hours" });
    const s = spec("every 30m");
    // Steps from the anchor, coalescing missed runs into the next one.
    expect(nextRun(s, NOW + 95 * 60_000, NOW)).toBe(NOW + 120 * 60_000);
    expect(upcoming(s, NOW, 2)).toEqual([NOW + 1_800_000, NOW + 3_600_000]);
  });

  it("compiles calendar phrases to cron, keeping the wording", () => {
    const weekdays = spec("Weekdays at 9am");
    expect(weekdays).toMatchObject({ kind: "cron", spec: "weekdays at 9am", description: "Weekdays at 9:00 AM" });
    // Wednesday 10:00 → Thursday 09:00.
    expect(iso(nextRun(weekdays, NOW, NOW))).toBe("2026-11-05T14:00:00.000Z");
    expect(spec("daily at 18:30").description).toBe("Daily at 6:30 PM");
    expect(spec("every day at noon").description).toBe("Daily at 12:00 PM");
    expect(spec("every monday 9am").description).toBe("Every Monday at 9:00 AM");
    expect(iso(nextRun(spec("every monday 9am"), NOW, NOW))).toBe("2026-11-09T14:00:00.000Z");
    expect(spec("every mon, wed and fri at 8:15").description).toBe("Mon, Wed, Fri at 8:15 AM");
    expect(spec("weekends at 10am").description).toBe("Weekends at 10:00 AM");
    expect(spec("hourly").description).toBe("Every hour, on the hour");
  });

  it("reads cron expressions in the schedule's zone", () => {
    const s = spec("0 9 * * 1-5");
    expect(s).toMatchObject({ kind: "cron", spec: "0 9 * * 1-5" });
    expect(iso(nextRun(s, NOW, NOW))).toBe("2026-11-05T14:00:00.000Z");
    expect(error("61 * * * *")).toMatch(/not a valid cron/);
  });

  it("explains what it cannot read", () => {
    expect(error("whenever")).toMatch(/could not read/);
    expect(error("daily")).toMatch(/add a time/);
    expect(error("2026-12-01")).toMatch(/add a time/);
    expect(parseSpec("every 30m", "Mars/Olympus").ok).toBe(false);
  });

  it("measures how often a schedule runs and how late a run may start", () => {
    expect(shortestGap(spec("*/2 * * * *"), NOW)).toBe(120_000);
    expect(shortestGap(spec("every 30m"), NOW)).toBe(1_800_000);
    expect(shortestGap(spec("in 1h"), NOW)).toBeNull();
    expect(graceMs(spec("every 30m"), NOW)).toBe(15 * 60_000);
    expect(graceMs(spec("every 5m"), NOW)).toBe(150_000);
    expect(graceMs(spec("in 1h"), NOW)).toBe(2 * 3_600_000);
    expect(graceMs(spec("daily at 9am"), Date.parse("2026-11-05T14:00:00Z"))).toBe(2 * 3_600_000);
  });
});
