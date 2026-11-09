import { describe, expect, it } from "vitest";
import { iosBuildNumber, latestReleaseTag, nightlyVersion, parseReleaseTag, resolveStamp, type StampInput } from "./version.ts";

const sha = "a".repeat(40);
const base: StampInput = { ref: null, commit: sha, runNumber: null, commitCount: 412, tags: [], now: new Date("2026-11-08T23:59:30Z") };

describe("parseReleaseTag", () => {
  it("accepts strict vX.Y.Z", () => {
    expect(parseReleaseTag("v0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parseReleaseTag("v10.20.300")).toEqual({ major: 10, minor: 20, patch: 300 });
  });
  it.each(["0.1.0", "v0.1", "v01.0.0", "v0.01.0", "v1.2.3-rc.1", "v1.2.3+meta", "v1.2.3 ", "vv1.2.3", "v1.2.3.4", ""])("rejects %j", (tag) => {
    expect(parseReleaseTag(tag)).toBeNull();
  });
});

describe("latestReleaseTag", () => {
  it("compares numerically and ignores junk", () => {
    expect(latestReleaseTag(["v0.9.0", "v0.10.0", "v0.2.11", "nightly", "v1.0.0-rc.1"])?.tag).toBe("v0.10.0");
    expect(latestReleaseTag([])).toBeNull();
  });
});

describe("nightlyVersion", () => {
  it("is the next patch, pre-release tagged with UTC day and run", () => {
    expect(nightlyVersion({ major: 0, minor: 3, patch: 2 }, new Date("2026-11-08T23:59:30Z"), 57)).toBe("0.3.3-nightly.20261108.57");
    expect(nightlyVersion(null, new Date("2026-01-02T00:00:00Z"), 1)).toBe("0.0.1-nightly.20260102.1");
  });
  it("rejects bad run numbers", () => {
    expect(() => nightlyVersion(null, new Date(), 0)).toThrow();
    expect(() => nightlyVersion(null, new Date(), 1.5)).toThrow();
  });
});

describe("iosBuildNumber", () => {
  it("is the UTC minute, matching testflight.sh's 12-digit format", () => {
    expect(iosBuildNumber(new Date("2026-11-08T01:29:59Z"))).toBe("202611080129");
    expect(iosBuildNumber(new Date("2026-12-31T23:59:00-05:00"))).toBe("202701010459");
  });
  it("increases within a day and across days", () => {
    const a = iosBuildNumber(new Date("2026-11-08T23:58:00Z"));
    const b = iosBuildNumber(new Date("2026-11-08T23:59:00Z"));
    const c = iosBuildNumber(new Date("2026-11-09T00:00:00Z"));
    expect(Number(a) < Number(b) && Number(b) < Number(c)).toBe(true);
  });
});

describe("resolveStamp", () => {
  it("release tag", () => {
    expect(resolveStamp({ ...base, ref: "refs/tags/v0.4.0", runNumber: 9 })).toEqual({ version: "0.4.0", channel: "release", bundleVersion: "412", commit: sha });
  });
  it("refuses a malformed v* tag before anything is built", () => {
    expect(() => resolveStamp({ ...base, ref: "refs/tags/v0.4", runNumber: 9 })).toThrow(/not a release tag/);
    expect(() => resolveStamp({ ...base, ref: "refs/tags/v0.4.0-rc.1", runNumber: 9 })).toThrow(/not a release tag/);
  });
  it("nightly on main follows the latest reachable tag", () => {
    expect(resolveStamp({ ...base, ref: "refs/heads/main", runNumber: 31, tags: ["v0.3.9", "v0.4.0"] }).version).toBe("0.4.1-nightly.20261108.31");
  });
  it("refuses other branches and missing run numbers", () => {
    expect(() => resolveStamp({ ...base, ref: "refs/heads/feature/x", runNumber: 1 })).toThrow(/refusing/);
    expect(() => resolveStamp({ ...base, ref: "refs/pull/3/merge", runNumber: 1 })).toThrow(/refusing/);
    expect(() => resolveStamp({ ...base, ref: "refs/heads/main" })).toThrow(/RUN_NUMBER/);
  });
  it("local builds", () => {
    expect(resolveStamp(base)).toMatchObject({ version: "0.0.0-local+aaaaaaaaaa", channel: "local" });
  });
  it("validates commit and count", () => {
    expect(() => resolveStamp({ ...base, commit: "abc" })).toThrow();
    expect(() => resolveStamp({ ...base, commitCount: 0 })).toThrow();
  });
  it("bundle version is the same for the nightly and tag build of one commit", () => {
    const n = resolveStamp({ ...base, ref: "refs/heads/main", runNumber: 5 });
    const t = resolveStamp({ ...base, ref: "refs/tags/v1.0.0", runNumber: 6 });
    expect(n.bundleVersion).toBe(t.bundleVersion);
  });
});
