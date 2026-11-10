import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkForUpdate, type CheckDeps } from "./check.ts";
import { downloadVerified, type Fetch, expectedAssetUrl } from "./github.ts";
import { trustedKeys } from "./keys.ts";
import type { Manifest } from "./manifestFormat.ts";
import { parsePublicKey } from "./minisign.ts";
import type { RunningBuild } from "./policy.ts";
import { afterCheck, EMPTY_STATE, intervalAfter, nextCheckAt, parseState, withSkipped } from "./state.ts";
import { comment, makeKey, manifest, minisign, TEAM } from "./testing/fixtures.ts";

const REPO = "LucFauvel/apollo-agent";
const running: RunningBuild = { version: "1.2.0", channel: "release", build: 400, schemaVersion: 20, platform: "darwin", arch: "arm64", osVersion: "15.3.1" };
const key = makeKey();
const keys = { configured: true as const, keys: [parsePublicKey(key.publicLine)], notes: [] };

/** A fake GitHub: the latest-release API and asset downloads, recording every request. */
const github = (o: {
  readonly m?: Manifest;
  readonly manifestText?: string;
  readonly signature?: string;
  readonly tag?: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly assetOverrides?: Record<string, Partial<{ size: number; digest: string; browser_download_url: string }>>;
}) => {
  const m = o.m ?? manifest();
  const tag = o.tag ?? `v${m.version}`;
  const manifestText = o.manifestText ?? JSON.stringify(m);
  const signature = o.signature ?? minisign(Buffer.from(manifestText), key, comment(m));
  const files: Record<string, string> = { "apollo-update.json": manifestText, "apollo-update.json.minisig": signature };
  const assets = [
    ...m.assets.map((a) => ({ name: a.name, size: a.size, digest: `sha256:${a.sha256}`, browser_download_url: expectedAssetUrl(tag, a.name, REPO) })),
    ...Object.keys(files).map((name) => ({ name, size: files[name]!.length, digest: null, browser_download_url: expectedAssetUrl(tag, name, REPO) })),
  ].map((a) => ({ ...a, ...o.assetOverrides?.[a.name] }));
  const requests: Array<string> = [];
  const fetchFn: Fetch = async (url) => {
    requests.push(url);
    if (url === `https://api.github.com/repos/${REPO}/releases/latest`) {
      if (o.status) return new Response("{}", { status: o.status, headers: o.headers ?? {} });
      return Response.json({ tag_name: tag, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, draft: false, prerelease: false, assets });
    }
    const name = Object.keys(files).find((n) => url === expectedAssetUrl(tag, n, REPO));
    return name ? new Response(files[name]) : new Response("not found", { status: 404 });
  };
  return { fetchFn, requests };
};

const deps = (fetchFn: Fetch, over: Partial<CheckDeps> = {}): CheckDeps => ({ fetchFn, keys, running, teamId: TEAM, skipped: [], dbSchema: 20, now: 0, repo: REPO, ...over });

describe("checkForUpdate", () => {
  it("offers a newer, correctly signed release", async () => {
    const r = await checkForUpdate(deps(github({}).fetchFn));
    expect(r.kind).toBe("available");
    expect(r.kind === "available" && r.offer.asset.name).toBe("Apollo-1.3.0-arm64.zip");
    expect(r.kind === "available" && r.offer.url).toBe(`https://github.com/${REPO}/releases/download/v1.3.0/Apollo-1.3.0-arm64.zip`);
  });

  it("is up to date when the latest release is not newer", async () => {
    expect(await checkForUpdate(deps(github({ m: manifest({ build: 400 }) }).fetchFn))).toEqual({ kind: "up-to-date", latest: "1.3.0" });
  });

  it("does nothing at all without keys (no request is made)", async () => {
    const g = github({});
    const r = await checkForUpdate(deps(g.fetchFn, { keys: trustedKeys("", "") }));
    expect(r.kind).toBe("not-configured");
    expect(g.requests).toEqual([]);
  });

  it("refuses a manifest changed after signing", async () => {
    const m = manifest();
    const text = JSON.stringify(m);
    const g = github({ m, manifestText: text.replace('"size":1000', '"size":1001'), signature: minisign(Buffer.from(text), key, comment(m)) });
    expect(await checkForUpdate(deps(g.fetchFn))).toEqual({ kind: "refused", reason: "release v1.3.0: the signature does not match the file" });
  });

  it("refuses a manifest signed by a key the app does not embed", async () => {
    const m = manifest();
    const text = JSON.stringify(m);
    const r = await checkForUpdate(deps(github({ m, manifestText: text, signature: minisign(Buffer.from(text), makeKey(), comment(m)) }).fetchFn));
    expect(r.kind === "refused" && r.reason).toMatch(/does not trust/);
  });

  it("refuses when the signed trusted comment disagrees with the manifest", async () => {
    const m = manifest();
    const text = JSON.stringify(m);
    const r = await checkForUpdate(deps(github({ m, manifestText: text, signature: minisign(Buffer.from(text), key, comment({ ...m, build: 999 })) }).fetchFn));
    expect(r.kind === "refused" && r.reason).toMatch(/signature is for build 999/);
  });

  it("never parses an unsigned manifest (a signed non-JSON body is refused only after the signature)", async () => {
    const text = "not json";
    const r = await checkForUpdate(deps(github({ manifestText: text, signature: minisign(Buffer.from(text), makeKey(), "x") }).fetchFn));
    expect(r.kind === "refused" && r.reason).toMatch(/does not trust/);
  });

  it("refuses a release whose tag is not v<version>", async () => {
    const r = await checkForUpdate(deps(github({ tag: "v9.9.9" }).fetchFn));
    expect(r.kind === "refused" && r.reason).toMatch(/does not belong to release v9.9.9/);
  });

  it("refuses when GitHub's listing disagrees with the signed manifest (size, digest, URL)", async () => {
    for (const override of [{ size: 999 }, { digest: `sha256:${"0".repeat(64)}` }, { browser_download_url: "https://evil.example/Apollo-1.3.0-arm64.zip" }]) {
      const r = await checkForUpdate(deps(github({ assetOverrides: { "Apollo-1.3.0-arm64.zip": override } }).fetchFn));
      expect(r.kind, JSON.stringify(override)).toBe("refused");
    }
    const sig = await checkForUpdate(deps(github({ assetOverrides: { "apollo-update.json": { browser_download_url: "https://evil.example/m.json" } } }).fetchFn));
    expect(sig.kind).toBe("refused");
  });

  it("does not offer a build that was rolled back here", async () => {
    expect(await checkForUpdate(deps(github({}).fetchFn, { skipped: [500] }))).toEqual({ kind: "skipped", version: "1.3.0" });
  });

  it("reports no release, rate limits and errors", async () => {
    expect(await checkForUpdate(deps(github({ status: 404 }).fetchFn))).toEqual({ kind: "no-release" });
    expect(await checkForUpdate(deps(github({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "5000" } }).fetchFn))).toEqual({ kind: "rate-limited", retryAt: 5_000_000 });
    expect((await checkForUpdate(deps(github({ status: 500 }).fetchFn))).kind).toBe("error");
    expect((await checkForUpdate(deps(async () => Promise.reject(new Error("offline"))))).kind).toBe("error");
  });
});

describe("downloadVerified", () => {
  const body = randomBytes(300_000);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const serve = (bytes: Uint8Array): Fetch => async () => new Response(bytes);
  const path = () => join(mkdtempSync(join(tmpdir(), "updater-dl-")), "asset.zip");

  it("streams the asset to disk, reporting progress, when size and SHA-256 match", async () => {
    const p = path();
    const progress: Array<number> = [];
    await downloadVerified({ fetchFn: serve(body), url: "u", path: p, expected: { size: body.length, sha256 }, onProgress: (r) => progress.push(r) });
    expect(readFileSync(p).equals(body)).toBe(true);
    expect(progress.at(-1)).toBe(body.length);
  });

  it("fails on a wrong hash, a short body or a body larger than the manifest says", async () => {
    await expect(downloadVerified({ fetchFn: serve(body), url: "u", path: path(), expected: { size: body.length, sha256: "0".repeat(64) } })).rejects.toThrow(/SHA-256/);
    await expect(downloadVerified({ fetchFn: serve(body.subarray(1)), url: "u", path: path(), expected: { size: body.length, sha256 } })).rejects.toThrow(/downloaded 299999 bytes/);
    await expect(downloadVerified({ fetchFn: serve(body), url: "u", path: path(), expected: { size: 1000, sha256 } })).rejects.toThrow(/larger than/);
  });

  it("never overwrites an existing file", async () => {
    const p = path();
    await downloadVerified({ fetchFn: serve(body), url: "u", path: p, expected: { size: body.length, sha256 } });
    await expect(downloadVerified({ fetchFn: serve(body), url: "u", path: p, expected: { size: body.length, sha256 } })).rejects.toThrow(/EEXIST/);
    expect(existsSync(p)).toBe(true);
  });
});

describe("check schedule", () => {
  const H = 60 * 60_000;

  it("checks soon after the first start, but never in the first two minutes", () => {
    expect(nextCheckAt(EMPTY_STATE, 0, 0, true)).toBe(2 * 60_000);
    expect(nextCheckAt(EMPTY_STATE, 0, 0.999, true)).toBeLessThan(8 * 60_000);
  });

  it("waits the interval (plus up to 10% jitter) after a successful check, across restarts", () => {
    const s = afterCheck(EMPTY_STATE, { kind: "up-to-date", latest: null }, 1000);
    expect(nextCheckAt(s, 2000, 0, true)).toBe(1000 + 6 * H);
    expect(nextCheckAt(s, 2000, 0.5, false)).toBe(1000 + 6 * H + 0.3 * H);
  });

  it("backs off on failures and honours GitHub's retry time", () => {
    let s = EMPTY_STATE;
    for (let i = 0; i < 3; i++) s = afterCheck(s, { kind: "error", message: "x" }, 0);
    expect(s.failures).toBe(3);
    expect(intervalAfter(1)).toBe(0.5 * H);
    expect(intervalAfter(3)).toBe(2 * H);
    expect(intervalAfter(20)).toBe(24 * H);
    const limited = afterCheck(EMPTY_STATE, { kind: "rate-limited", retryAt: 10 * H }, 0);
    expect(nextCheckAt(limited, 0, 0, false)).toBe(10 * H);
    expect(afterCheck(limited, { kind: "no-release" }, H)).toMatchObject({ failures: 0, retryAt: null });
  });

  it("keeps skipped builds through a damaged state file, and never lists one twice", () => {
    const s = withSkipped(withSkipped(EMPTY_STATE, { build: 5, version: "1", at: "", why: "" }), { build: 5, version: "1", at: "", why: "" });
    expect(s.skipped).toHaveLength(1);
    expect(parseState(JSON.stringify({ ...s, failures: "lots", lastCheckAt: "never" })).skipped).toEqual(s.skipped);
    expect(parseState("{nope")).toEqual(EMPTY_STATE);
  });
});
