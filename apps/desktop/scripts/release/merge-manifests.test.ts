import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatSums, type Manifest, parseManifest, partialManifestName } from "./manifest.ts";

const script = join(dirname(fileURLToPath(import.meta.url)), "merge-manifests.ts");
const commit = "c".repeat(40);
const base = { format: 2, version: "1.2.3", build: 123, commit, channel: "release", schemaVersion: 19, publishedAt: "2026-11-09T00:00:00Z", notes: "" } as const;
const parts = (): Array<Manifest> => [
  { ...base, assets: [{ name: "Apollo-1.2.3-arm64.zip", platform: "darwin", arch: "arm64", kind: "zip", codeSigning: { kind: "developer-id", team: "XA3R5NAN2C" }, minOs: "13.0", size: 0, sha256: "" }] },
  { ...base, assets: [{ name: "Apollo-1.2.3-win-x64-unsigned-setup.exe", platform: "win32", arch: "x64", kind: "nsis", codeSigning: { kind: "unsigned" }, minOs: "10", size: 0, sha256: "" }] },
  { ...base, assets: [{ name: "Apollo-1.2.3-win-arm64-unsigned-setup.exe", platform: "win32", arch: "arm64", kind: "nsis", codeSigning: { kind: "unsigned" }, minOs: "10", size: 0, sha256: "" }] },
];

/** Writes each part as a build output dir (files with real hashes), runs the CLI. */
const runMerge = (manifests: Array<Manifest>) => {
  const root = mkdtempSync(join(tmpdir(), "merge-cli-"));
  const dirs = manifests.map((m, i) => {
    const dir = join(root, `part${i}`);
    mkdirSync(dir);
    const assets = m.assets.map((a) => {
      const bytes = Buffer.from(`fixture ${i} ${a.name}`);
      writeFileSync(join(dir, a.name), bytes);
      return { ...a, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    const a0 = m.assets[0]!;
    writeFileSync(join(dir, partialManifestName(a0.platform, a0.arch)), JSON.stringify({ ...m, assets }));
    writeFileSync(join(dir, "SHA256SUMS"), formatSums(assets));
    return dir;
  });
  const r = spawnSync(process.execPath, [script, "--out", join(root, "out"), "--version", "1.2.3", "--commit", commit, ...dirs], { encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}`, out: join(root, "out") };
};

describe("merge-manifests CLI", () => {
  it("merges three consistent platform builds", () => {
    const r = runMerge(parts());
    expect(r.status, r.output).toBe(0);
    expect(parseManifest(readFileSync(join(r.out, "apollo-update.json"), "utf8")).assets).toHaveLength(3);
  });
  it("refuses the reviewer's fixture: an unmarked unsigned x64 installer and an arm64 entry with an x64 name", () => {
    const p = parts();
    p[1] = { ...p[1]!, assets: [{ ...p[1]!.assets[0]!, name: "Apollo-1.2.3-win-x64-setup.exe" }] };
    p[2] = { ...p[2]!, assets: [{ ...p[2]!.assets[0]!, name: "Apollo-1.2.3-win-x64-wrongarch-setup.exe" }] };
    const r = runMerge(p);
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/Apollo-1.2.3-win-x64-setup.exe: name disagrees/);
    expect(r.output).toMatch(/Apollo-1.2.3-win-x64-wrongarch-setup.exe: name disagrees/);
  });
});
