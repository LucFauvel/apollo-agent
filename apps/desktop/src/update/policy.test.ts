import { describe, expect, it } from "vitest";
import { commentProblems, compareOsVersions, decide, type DecideOptions, parseTrustedComment, type RunningBuild } from "./policy.ts";
import { COMMIT, comment, manifest, TEAM } from "./testing/fixtures.ts";

const mac: RunningBuild = { version: "1.2.0", channel: "release", build: 400, schemaVersion: 20, platform: "darwin", arch: "arm64", osVersion: "15.3.1" };
const opts: DecideOptions = { tag: "v1.3.0", teamId: TEAM, skipped: [], dbSchema: 20 };

describe("trusted comment", () => {
  it("parses exactly CI's format", () => {
    expect(parseTrustedComment(`apollo-update version=1.3.0 build=500 commit=${COMMIT}`)).toEqual({ version: "1.3.0", build: 500, commit: COMMIT });
    for (const bad of [
      `apollo-update version=1.3.0 build=500 commit=${COMMIT} extra`,
      `apollo-update version=1.3.0 build=500`,
      `timestamp:1700000000\tfile:apollo-update.json`,
      `apollo-update version=1.3.0 build=0 commit=${COMMIT}`,
      `apollo-update version=1.3.0 build=500 commit=${COMMIT.toUpperCase()}`,
    ]) {
      expect(parseTrustedComment(bad), bad).toBeNull();
    }
  });

  it("must agree with the manifest on version, build and commit", () => {
    const m = manifest();
    expect(commentProblems(comment(m), m)).toEqual([]);
    expect(commentProblems(comment({ ...m, version: "1.3.1" }), m)).toHaveLength(1);
    expect(commentProblems(comment({ ...m, build: 501 }), m)).toHaveLength(1);
    expect(commentProblems(comment({ ...m, commit: "f".repeat(40) }), m)).toHaveLength(1);
    expect(commentProblems("not ours", m)[0]).toMatch(/not an apollo-update comment/);
  });
});

describe("decide", () => {
  it("offers the Developer ID zip for this platform and arch when the build is newer", () => {
    const d = decide(manifest(), mac, opts);
    expect(d).toEqual({ kind: "offer", asset: expect.objectContaining({ name: "Apollo-1.3.0-arm64.zip", kind: "zip" }) });
  });

  it("never downgrades or reinstalls: build must be strictly greater", () => {
    expect(decide(manifest({ build: 400 }), mac, opts).kind).toBe("up-to-date");
    expect(decide(manifest({ build: 399 }), mac, opts).kind).toBe("up-to-date");
    expect(decide(manifest({ build: 401 }), mac, opts).kind).toBe("offer");
  });

  it("never updates a build without a build number", () => {
    expect(decide(manifest(), { ...mac, build: null, channel: "local" }, opts).kind).toBe("refuse");
  });

  it("never crosses channels: only release manifests, for release and nightly apps alike", () => {
    expect(decide(manifest({ channel: "nightly" }), mac, opts).kind).toBe("refuse");
    expect(decide(manifest({ channel: "local" }), mac, opts).kind).toBe("refuse");
    expect(decide(manifest({ channel: "nightly" }), { ...mac, channel: "nightly" }, opts).kind).toBe("refuse");
    expect(decide(manifest(), { ...mac, channel: "nightly" }, opts).kind).toBe("offer");
    // A nightly of a later commit than the release: the release is not newer, so nothing.
    expect(decide(manifest(), { ...mac, channel: "nightly", build: 510 }, opts).kind).toBe("up-to-date");
  });

  it("requires the release tag to be v<version>", () => {
    expect(decide(manifest(), mac, { ...opts, tag: "v1.2.9" }).kind).toBe("refuse");
  });

  it("refuses a schema older than the running build's, or than the database's", () => {
    expect(decide(manifest({ schemaVersion: 19 }), mac, opts)).toEqual({ kind: "refuse", reason: expect.stringMatching(/schema 19, older/) });
    expect(decide(manifest(), mac, { ...opts, dbSchema: 21 })).toEqual({ kind: "refuse", reason: expect.stringMatching(/cannot open the database/) });
    expect(decide(manifest({ schemaVersion: 22 }), mac, { ...opts, dbSchema: 21 }).kind).toBe("offer");
    expect(decide(manifest(), mac, { ...opts, dbSchema: null }).kind).toBe("offer");
  });

  it("does not re-offer a build that was rolled back here", () => {
    expect(decide(manifest(), mac, { ...opts, skipped: [500] })).toEqual({ kind: "skipped", build: 500 });
  });

  it("requires Developer ID signing by the pinned team on macOS", () => {
    const withSigning = (codeSigning: never) => {
      const m = manifest();
      return { ...m, assets: m.assets.map((a) => (a.kind === "zip" ? { ...a, codeSigning } : a)) };
    };
    expect(decide(withSigning({ kind: "developer-id", team: "ABCDE12345" } as never), mac, opts)).toEqual({ kind: "refuse", reason: expect.stringMatching(/team ABCDE12345, not XA3R5NAN2C/) });
    // An ad-hoc asset with the matching (ad-hoc) name: refused for its signing.
    const adhoc = withSigning({ kind: "adhoc" } as never);
    const renamed = { ...adhoc, assets: adhoc.assets.map((a) => (a.kind === "zip" ? { ...a, name: "Apollo-1.3.0-arm64-adhoc.zip" } : a)) };
    expect(decide(renamed, mac, opts)).toEqual({ kind: "refuse", reason: expect.stringMatching(/adhoc-signed, not Developer ID/) });
    expect(decide(manifest(), mac, { ...opts, teamId: "ZZZZZZZZZZ" }).kind).toBe("refuse");
  });

  it("requires the asset name expectedAssetName gives", () => {
    const m = manifest();
    const renamed = { ...m, assets: m.assets.map((a) => (a.kind === "zip" ? { ...a, name: "Apollo-1.3.0-arm64-adhoc.zip" } : a)) };
    expect(decide(renamed, mac, opts)).toEqual({ kind: "refuse", reason: expect.stringMatching(/is not named Apollo-1.3.0-arm64.zip/) });
  });

  it("refuses when there is no asset, or more than one, for this platform and arch", () => {
    expect(decide(manifest(), { ...mac, arch: "x64" }, opts).kind).toBe("refuse");
    const m = manifest();
    expect(decide({ ...m, assets: [...m.assets, { ...m.assets[0]!, name: "dup.zip" }] }, mac, opts).kind).toBe("refuse");
  });

  it("refuses implausible sizes and too-old systems", () => {
    const m = manifest();
    const sized = (size: number) => ({ ...m, assets: m.assets.map((a) => (a.kind === "zip" ? { ...a, size } : a)) });
    expect(decide(sized(0), mac, opts).kind).toBe("refuse");
    expect(decide(sized(3 * 1024 ** 3), mac, opts).kind).toBe("refuse");
    expect(decide(manifest(), { ...mac, osVersion: "11.7" }, opts)).toEqual({ kind: "refuse", reason: "version 1.3.0 needs macOS 12.0 or later" });
  });

  it("picks the NSIS installer on Windows (offered for a manual install)", () => {
    const win: RunningBuild = { ...mac, platform: "win32", arch: "x64", osVersion: "10.0.22631" };
    expect(decide(manifest(), win, opts)).toEqual({ kind: "offer", asset: expect.objectContaining({ kind: "nsis" }) });
  });

  it("compares OS versions numerically", () => {
    expect(compareOsVersions("15.10", "15.9")).toBeGreaterThan(0);
    expect(compareOsVersions("12", "12.0.0")).toBe(0);
    expect(compareOsVersions("11.7.10", "12.0")).toBeLessThan(0);
  });
});
