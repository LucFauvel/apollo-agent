import { describe, expect, it } from "vitest";
import type { Manifest } from "./manifest.ts";
import { checkRelease, type ReleaseFacts, trustedComment } from "./release-checks.ts";

const commit = "c".repeat(40);
const manifest: Manifest = {
  format: 2,
  version: "0.4.0",
  build: 412,
  commit,
  channel: "release",
  schemaVersion: 19,
  publishedAt: "2026-11-08T00:00:00Z",
  assets: [
    { name: "Apollo-0.4.0-arm64.zip", platform: "darwin", arch: "arm64", kind: "zip", size: 1, sha256: "1".repeat(64), codeSigning: { kind: "developer-id", team: "XA3R5NAN2C" }, minOs: "13.0" },
    { name: "Apollo-0.4.0-win-x64-unsigned-setup.exe", platform: "win32", arch: "x64", kind: "nsis", size: 1, sha256: "2".repeat(64), codeSigning: { kind: "unsigned" }, minOs: "10" },
    { name: "Apollo-0.4.0-win-arm64-setup.exe", platform: "win32", arch: "arm64", kind: "nsis", size: 1, sha256: "3".repeat(64), codeSigning: { kind: "authenticode", publisher: "Luc Fauvel" }, minOs: "10" },
  ],
  notes: "",
};
const withAsset = (i: number, patch: Partial<Manifest["assets"][number]>): Manifest => ({
  ...manifest,
  assets: manifest.assets.map((a, j) => (j === i ? ({ ...a, ...patch } as Manifest["assets"][number]) : a)),
});
const draft: ReleaseFacts = {
  tag: "v0.4.0",
  tagCommit: commit,
  onMain: true,
  release: { isDraft: true, isPrerelease: false },
  manifest,
  assetProblems: [],
  signature: "absent",
  nightlyGreen: false,
};
const candidate: ReleaseFacts = { ...draft, release: { isDraft: false, isPrerelease: true }, signature: "valid", nightlyGreen: true };

describe("checkRelease: sign", () => {
  it("passes a consistent Developer ID draft", () => {
    expect(checkRelease(draft, "sign")).toEqual([]);
  });
  it.each<[string, Partial<ReleaseFacts>, RegExp]>([
    ["malformed tag", { tag: "v0.4" }, /not a release tag/],
    ["missing tag", { tagCommit: null }, /does not exist/],
    ["tag off main", { onMain: false }, /not on origin\/main/],
    ["other commit", { tagCommit: "d".repeat(40) }, /manifest commit/],
    ["wrong version", { tag: "v0.4.1" }, /manifest version 0.4.0 != tag v0.4.1/],
    ["ad-hoc macOS build", { manifest: withAsset(0, { codeSigning: { kind: "adhoc" } }) }, /Apollo-0.4.0-arm64.zip is adhoc: a darwin release needs developer-id/],
    ["a missing Windows arch", { manifest: { ...manifest, assets: manifest.assets.slice(0, 2) } }, /no win32-arm64 build/],
    ["an extra target", { manifest: withAsset(2, { arch: "ia32" }) }, /unexpected win32-ia32 build/],
    // The reviewer's P2-1 probes reach checkRelease with assetProblems empty: the policy itself must refuse.
    ["an unsigned installer without -unsigned in its name", { manifest: withAsset(1, { name: "Apollo-0.4.0-win-x64-setup.exe" }) }, /win-x64-setup.exe: name disagrees/],
    ["an x64 name on the arm64 entry", { manifest: withAsset(2, { name: "Apollo-0.4.0-win-x64-wrongarch-setup.exe" }) }, /wrongarch-setup.exe: name disagrees.*win32-arm64/],
    ["a nightly-looking name under release metadata", { manifest: withAsset(0, { name: "Apollo-0.4.0-nightly.20261109.1-arm64.zip" }) }, /nightly.20261109.1-arm64.zip: name disagrees/],
    ["a .exe name on a macOS zip entry", { manifest: withAsset(0, { name: "Apollo-0.4.0-arm64.exe" }) }, /arm64.exe: name disagrees/],
    ["nightly manifest", { manifest: { ...manifest, channel: "nightly" } }, /channel is nightly/],
    ["hash mismatch", { assetProblems: ["x.zip: sha256 a != manifest b"] }, /x.zip: sha256/],
    ["already published", { release: { isDraft: false, isPrerelease: true } }, /already published/],
    ["already signed", { signature: "valid" }, /refusing to sign it again/],
    ["foreign signature", { signature: "invalid" }, /refusing to sign it again/],
  ])("refuses: %s", (_, patch, pattern) => {
    expect(checkRelease({ ...draft, ...patch }, "sign").join("\n")).toMatch(pattern);
  });
});

describe("checkRelease: promote", () => {
  it("passes a signed prerelease whose commit had a green nightly", () => {
    expect(checkRelease(candidate, "promote")).toEqual([]);
  });
  it.each<[string, Partial<ReleaseFacts>, RegExp]>([
    ["still a draft", { release: { isDraft: true, isPrerelease: false } }, /still a draft/],
    ["already stable", { release: { isDraft: false, isPrerelease: false } }, /not a prerelease/],
    ["unsigned", { signature: "absent" }, /signature is absent/],
    ["bad signature", { signature: "invalid" }, /signature is invalid/],
    ["no green nightly for the commit (same-commit rule)", { nightlyGreen: false }, /no successful nightly/],
    ["tampered asset", { assetProblems: ["Apollo-0.4.0-arm64.zip: sha256 x != manifest y"] }, /sha256/],
  ])("refuses: %s", (_, patch, pattern) => {
    expect(checkRelease({ ...candidate, ...patch }, "promote").join("\n")).toMatch(pattern);
  });
});

describe("trustedComment", () => {
  it("binds version, build and commit", () => {
    expect(trustedComment(manifest)).toBe(`apollo-update version=0.4.0 build=412 commit=${commit}`);
  });
});
