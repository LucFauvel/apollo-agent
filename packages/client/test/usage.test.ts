import type { UsageMeter } from "@apollo/contracts";
import { describe, expect, it } from "vitest";
import { meterTone, percentLeft, relativeTime } from "../src/usage.ts";

const meter = (fields: Partial<UsageMeter> = {}): UsageMeter => ({
  label: "Weekly",
  usedPercent: 40,
  resetsAt: null,
  severity: null,
  headline: false,
  ...fields,
});

describe("usage meters", () => {
  it("rounds and clamps what is left", () => {
    expect(percentLeft(meter({ usedPercent: 40.4 }))).toBe(60);
    expect(percentLeft(meter({ usedPercent: 120 }))).toBe(0);
    expect(percentLeft(meter({ usedPercent: -5 }))).toBe(100);
  });

  it("prefers the provider's grading, else grades by how full it is", () => {
    expect(meterTone(meter({ usedPercent: 95, severity: "normal" }))).toBe("normal");
    expect(meterTone(meter({ usedPercent: 10, severity: "critical" }))).toBe("critical");
    expect(meterTone(meter({ usedPercent: 10, severity: "warning" }))).toBe("warning");
    expect(meterTone(meter({ usedPercent: 90 }))).toBe("critical");
    expect(meterTone(meter({ usedPercent: 75 }))).toBe("warning");
    expect(meterTone(meter({ usedPercent: 74 }))).toBe("normal");
  });

  it("words times relative to now", () => {
    expect(relativeTime(1_000 + 30_000, 1_000)).toBe("in less than a minute");
    expect(relativeTime(0, 3 * 3_600_000)).toBe("3 h ago");
    expect(relativeTime(2 * 86_400_000, 0)).toBe("in 2 d");
    expect(relativeTime(12 * 60_000, 0)).toBe("in 12 min");
  });
});
