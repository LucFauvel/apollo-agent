import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareAssets, formatSums, type Manifest, parseManifest, parseSums, sha256File } from "./manifest.ts";

const h = (c: string) => c.repeat(64);
const manifest: Manifest = {
  format: 1,
  version: "0.4.0",
  build: 412,
  commit: "b".repeat(40),
  channel: "release",
  schemaVersion: 18,
  minMacos: "12.0",
  publishedAt: "2026-11-08T00:00:00Z",
  codeSigning: { kind: "adhoc" },
  assets: [
    { name: "Apollo-0.4.0-arm64.zip", arch: "arm64", size: 10, sha256: h("1") },
    { name: "Apollo-0.4.0-arm64.dmg", arch: "arm64", size: 20, sha256: h("2") },
  ],
  notes: "",
};
const sums = () => parseSums(formatSums(manifest.assets));
const files = () =>
  new Map([
    ["Apollo-0.4.0-arm64.zip", { size: 10, sha256: h("1") }],
    ["Apollo-0.4.0-arm64.dmg", { size: 20, sha256: h("2") }],
    ["apollo-update.json", { size: 1, sha256: h("3") }],
    ["SHA256SUMS", { size: 1, sha256: h("4") }],
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
    const text = formatSums(manifest.assets);
    expect(text).toBe(`${h("2")}  Apollo-0.4.0-arm64.dmg\n${h("1")}  Apollo-0.4.0-arm64.zip\n`);
    expect(parseSums(text).get("Apollo-0.4.0-arm64.zip")).toBe(h("1"));
  });
  it("rejects malformed and duplicate lines", () => {
    expect(() => parseSums("nothex  a\n")).toThrow(/malformed/);
    expect(() => parseSums(`${h("1")}  a\n${h("2")}  a\n`)).toThrow(/twice/);
  });
});

describe("parseManifest", () => {
  it("accepts a good manifest", () => {
    expect(parseManifest(JSON.stringify(manifest)).version).toBe("0.4.0");
  });
  it.each([
    ["format", { format: 2 }],
    ["commit", { commit: "short" }],
    ["channel", { channel: "beta" }],
    ["codeSigning", { codeSigning: { kind: "developer-id" } }],
    ["no assets", { assets: [] }],
    ["path in name", { assets: [{ ...manifest.assets[0], name: "../x.zip" }] }],
    ["duplicate", { assets: [manifest.assets[0], manifest.assets[0]] }],
    ["bad hash", { assets: [{ ...manifest.assets[0], sha256: "x" }] }],
  ])("rejects %s", (_, patch) => {
    expect(() => parseManifest(JSON.stringify({ ...manifest, ...patch }))).toThrow();
  });
});

describe("compareAssets", () => {
  it("is empty when everything agrees", () => {
    expect(compareAssets(manifest, sums(), files())).toEqual([]);
  });
  it("tolerates the minisign signature asset", () => {
    const f = files();
    f.set("apollo-update.json.minisig", { size: 1, sha256: h("5") });
    expect(compareAssets(manifest, sums(), f)).toEqual([]);
  });
  it("flags a swapped asset", () => {
    const f = files();
    f.set("Apollo-0.4.0-arm64.zip", { size: 10, sha256: h("9") });
    const problems = compareAssets(manifest, sums(), f);
    expect(problems.join("\n")).toMatch(/zip: sha256 9+ != manifest/);
    expect(problems.join("\n")).toMatch(/zip: sha256 9+ != SHA256SUMS/);
  });
  it("flags size, missing, extra and unlisted files", () => {
    const f = files();
    f.set("Apollo-0.4.0-arm64.dmg", { size: 21, sha256: h("2") });
    f.delete("Apollo-0.4.0-arm64.zip");
    f.set("evil.pkg", { size: 1, sha256: h("6") });
    const s = sums();
    s.set("other", h("7"));
    const text = compareAssets(manifest, s, f).join("\n");
    expect(text).toMatch(/dmg: size 21 != manifest 20/);
    expect(text).toMatch(/zip: listed in the manifest but not in the release/);
    expect(text).toMatch(/evil.pkg: in the release but not in the manifest/);
    expect(text).toMatch(/other: in SHA256SUMS but not in the manifest/);
  });
});
