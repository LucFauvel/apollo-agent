import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareAssets,
  formatSums,
  type Manifest,
  type ManifestAsset,
  mergeManifests,
  parseManifest,
  parseSums,
  partialManifestName,
  RELEASE_TARGETS,
  sha256File,
  targetsOf,
} from "./manifest.ts";

const h = (c: string) => c.repeat(64);
const devId = { kind: "developer-id", team: "XA3R5NAN2C" } as const;
const mac = (name: string, kind: "zip" | "dmg", sha: string, size: number): ManifestAsset => ({
  name,
  platform: "darwin",
  arch: "arm64",
  kind,
  size,
  sha256: h(sha),
  codeSigning: devId,
  minOs: "13.0",
});
const win = (arch: string, sha: string): ManifestAsset => ({
  name: `Apollo-0.4.0-win-${arch}-unsigned-setup.exe`,
  platform: "win32",
  arch,
  kind: "nsis",
  size: 30,
  sha256: h(sha),
  codeSigning: { kind: "unsigned" },
  minOs: "10",
});
const base = {
  format: 2,
  version: "0.4.0",
  build: 412,
  commit: "b".repeat(40),
  channel: "release",
  schemaVersion: 19,
  publishedAt: "2026-11-08T00:00:00Z",
  notes: "",
} as const;
const macPart: Manifest = { ...base, assets: [mac("Apollo-0.4.0-arm64.zip", "zip", "1", 10), mac("Apollo-0.4.0-arm64.dmg", "dmg", "2", 20)] };
const winX64: Manifest = { ...base, publishedAt: "2026-11-08T00:05:00Z", assets: [win("x64", "3")] };
const winArm: Manifest = { ...base, publishedAt: "2026-11-08T00:03:00Z", assets: [win("arm64", "4")] };
const manifest = mergeManifests([macPart, winX64, winArm], RELEASE_TARGETS);

const sums = () => parseSums(formatSums(manifest.assets));
const files = () =>
  new Map<string, { size: number; sha256: string }>([
    ...manifest.assets.map((a) => [a.name, { size: a.size, sha256: a.sha256 }] as const),
    ["apollo-update.json", { size: 1, sha256: h("8") }],
    ["SHA256SUMS", { size: 1, sha256: h("9") }],
  ]);

describe("sha256File", () => {
  it("hashes a file", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "m-")), "f");
    writeFileSync(p, "abc");
    expect(await sha256File(p)).toEqual({ size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
  });
});

describe("SHA256SUMS", () => {
  it("round-trips sorted, shasum-compatible", () => {
    const text = formatSums(macPart.assets);
    expect(text).toBe(`${h("2")}  Apollo-0.4.0-arm64.dmg\n${h("1")}  Apollo-0.4.0-arm64.zip\n`);
    expect(parseSums(text).get("Apollo-0.4.0-arm64.zip")).toBe(h("1"));
  });
  it("rejects malformed and duplicate lines", () => {
    expect(() => parseSums("nothex  a\n")).toThrow(/malformed/);
    expect(() => parseSums(`${h("1")}  a\n${h("2")}  a\n`)).toThrow(/twice/);
  });
});

describe("parseManifest", () => {
  it("accepts the merged manifest and every partial one", () => {
    for (const m of [manifest, macPart, winX64, winArm]) expect(parseManifest(JSON.stringify(m)).version).toBe("0.4.0");
  });
  const asset0 = manifest.assets[0]!;
  it.each([
    ["format 1", { format: 1 }],
    ["commit", { commit: "short" }],
    ["channel", { channel: "beta" }],
    ["no assets", { assets: [] }],
    ["path in name", { assets: [{ ...asset0, name: "../x.zip" }] }],
    ["windows path in name", { assets: [{ ...asset0, name: "..\\x.zip" }] }],
    ["manifest-like name", { assets: [{ ...asset0, name: "apollo-update.json.minisig" }] }],
    ["duplicate", { assets: [asset0, asset0] }],
    ["bad hash", { assets: [{ ...asset0, sha256: "x" }] }],
    ["unknown platform", { assets: [{ ...asset0, platform: "linux" }] }],
    ["nsis on macOS", { assets: [{ ...mac("a-0.4.0-.zip", "zip", "1", 1), kind: "nsis" }] }],
    ["dmg on Windows", { assets: [{ ...win("x64", "3"), kind: "dmg" }] }],
    ["unsigned macOS", { assets: [{ ...mac("a-0.4.0-.zip", "zip", "1", 1), codeSigning: { kind: "unsigned" } }] }],
    ["developer-id on Windows", { assets: [{ ...win("x64", "3"), codeSigning: devId }] }],
    ["developer-id without team", { assets: [{ ...mac("a-0.4.0-.zip", "zip", "1", 1), codeSigning: { kind: "developer-id" } }] }],
    ["authenticode without publisher", { assets: [{ ...win("x64", "3"), codeSigning: { kind: "authenticode" } }] }],
    ["missing minOs", { assets: [{ ...win("x64", "3"), minOs: "" }] }],
  ])("rejects %s", (_, patch) => {
    expect(() => parseManifest(JSON.stringify({ ...manifest, ...patch }))).toThrow();
  });
});

describe("mergeManifests", () => {
  it("merges the platform builds: every asset, sorted, latest publishedAt", () => {
    expect(targetsOf(manifest)).toEqual(["darwin-arm64", "win32-arm64", "win32-x64"]);
    expect(manifest.assets.map((a) => a.name)).toEqual([
      "Apollo-0.4.0-arm64.dmg",
      "Apollo-0.4.0-arm64.zip",
      "Apollo-0.4.0-win-arm64-unsigned-setup.exe",
      "Apollo-0.4.0-win-x64-unsigned-setup.exe",
    ]);
    expect(manifest.publishedAt).toBe("2026-11-08T00:05:00Z");
    expect(manifest.format).toBe(2);
  });
  it("keeps the macOS-only case working without a required set", () => {
    expect(mergeManifests([macPart]).assets).toHaveLength(2);
  });
  it.each<[string, ReadonlyArray<Manifest>, RegExp]>([
    ["a missing platform", [macPart, winX64], /missing build for win32-arm64/],
    ["an unexpected platform", [macPart, winX64, winArm, { ...winArm, assets: [{ ...win("ia32", "5") }] }], /unexpected build for win32-ia32/],
    ["a target built twice", [macPart, winX64, winArm, { ...winX64, assets: [{ ...win("x64", "6"), name: "other-0.4.0-.exe" }] }], /win32-x64 is built twice/],
    ["a version mismatch", [macPart, { ...winX64, version: "0.4.1" }, winArm], /version differs/],
    ["a commit mismatch", [macPart, { ...winX64, commit: "c".repeat(40) }, winArm], /commit differs/],
    ["a schema mismatch", [macPart, winX64, { ...winArm, schemaVersion: 18 }], /schemaVersion differs/],
    ["a channel mismatch", [macPart, winX64, { ...winArm, channel: "nightly" }], /channel differs/],
    ["nothing", [], /no partial manifests/],
  ])("refuses %s", (_, parts, pattern) => {
    expect(() => mergeManifests(parts, RELEASE_TARGETS)).toThrow(pattern);
  });
  it("names partial manifests per target", () => {
    expect(partialManifestName("win32", "arm64")).toBe("apollo-update.win32-arm64.json");
  });
});

describe("compareAssets", () => {
  it("is empty when every platform's files agree", () => {
    expect(compareAssets(manifest, sums(), files())).toEqual([]);
  });
  it("tolerates the minisign signature asset", () => {
    const f = files();
    f.set("apollo-update.json.minisig", { size: 1, sha256: h("5") });
    expect(compareAssets(manifest, sums(), f)).toEqual([]);
  });
  it("flags a swapped Windows installer", () => {
    const f = files();
    f.set("Apollo-0.4.0-win-arm64-unsigned-setup.exe", { size: 30, sha256: h("7") });
    const problems = compareAssets(manifest, sums(), f).join("\n");
    expect(problems).toMatch(/win-arm64-unsigned-setup.exe: sha256 7+ != manifest 4+/);
    expect(problems).toMatch(/win-arm64-unsigned-setup.exe: sha256 7+ != SHA256SUMS/);
  });
  it("flags size, missing, extra and unlisted files", () => {
    const f = files();
    f.set("Apollo-0.4.0-arm64.dmg", { size: 21, sha256: h("2") });
    f.delete("Apollo-0.4.0-win-x64-unsigned-setup.exe");
    f.set("evil.pkg", { size: 1, sha256: h("6") });
    const s = sums();
    s.set("other", h("7"));
    const text = compareAssets(manifest, s, f).join("\n");
    expect(text).toMatch(/dmg: size 21 != manifest 20/);
    expect(text).toMatch(/win-x64-unsigned-setup.exe: listed in the manifest but not in the release/);
    expect(text).toMatch(/evil.pkg: in the release but not in the manifest/);
    expect(text).toMatch(/other: in SHA256SUMS but not in the manifest/);
  });
  it("flags an asset whose name carries another version", () => {
    const stale = { ...manifest, assets: [...manifest.assets.slice(1), { ...manifest.assets[0]!, name: "Apollo-0.3.9-arm64.dmg" }] };
    const f = files();
    f.delete("Apollo-0.4.0-arm64.dmg");
    f.set("Apollo-0.3.9-arm64.dmg", { size: 20, sha256: h("2") });
    expect(compareAssets(stale, parseSums(formatSums(stale.assets)), f).join("\n")).toMatch(/Apollo-0.3.9-arm64.dmg: name does not carry version 0.4.0/);
  });
});
