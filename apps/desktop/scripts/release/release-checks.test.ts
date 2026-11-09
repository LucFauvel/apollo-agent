import { describe, expect, it } from "vitest";
import type { Manifest } from "./manifest.ts";
import { checkRelease, type ReleaseFacts, trustedComment } from "./release-checks.ts";

const commit = "c".repeat(40);
const manifest: Manifest = {
  format: 1,
  version: "0.4.0",
  build: 412,
  commit,
  channel: "release",
  schemaVersion: 19,
  minMacos: "13.0",
  publishedAt: "2026-11-08T00:00:00Z",
  codeSigning: { kind: "developer-id", team: "XA3R5NAN2C" },
  assets: [{ name: "Apollo-0.4.0-arm64.zip", arch: "arm64", size: 1, sha256: "1".repeat(64) }],
  notes: "",
};
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
    ["ad-hoc build", { manifest: { ...manifest, codeSigning: { kind: "adhoc" } } }, /adhoc-signed/],
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
