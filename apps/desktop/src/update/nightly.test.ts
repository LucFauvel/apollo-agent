/**
 * The nightly update channel: its own key, its own releases (`nightly-<version>` prereleases),
 * opt-in, and never able to reach someone who follows stable releases.
 */
import { describe, expect, it } from "vitest";
import { checkForUpdate, type CheckDeps, type CheckResult, combineResults } from "./check.ts";
import { expectedAssetUrl, type Fetch, fetchLatestNightly } from "./github.ts";
import { stagedProblems } from "./helperCore.ts";
import { nightlyTrustedKeys, trustedKeys } from "./keys.ts";
import { type Manifest, releaseTagFor } from "./manifestFormat.ts";
import { decide, type DecideOptions, type RunningBuild } from "./policy.ts";
import { afterCheck, EMPTY_STATE, followedChannel, parseState, withInitialChannel } from "./state.ts";
import { comment, makeKey, manifest, minisign, TEAM, type TestKey } from "./testing/fixtures.ts";

const REPO = "LucFauvel/apollo-agent";
const running: RunningBuild = { version: "1.2.0", channel: "release", build: 400, schemaVersion: 20, platform: "darwin", arch: "arm64", osVersion: "15.3.1" };
const releaseKey = makeKey();
const nightlyKey = makeKey();
const releaseKeys = trustedKeys(releaseKey.publicLine, "");
const nightlyKeys = nightlyTrustedKeys(nightlyKey.publicLine, releaseKeys);

const nightlyManifest = (over: Partial<Manifest> = {}) => manifest({ version: "1.3.1-nightly.20261110.42", channel: "nightly", build: 520, ...over });

interface Published {
  readonly m: Manifest;
  readonly key: TestKey;
  readonly tag?: string;
  readonly prerelease?: boolean;
  readonly draft?: boolean;
}

/** A fake GitHub with a stable "latest" release and a newest-first release list. */
const github = (o: { readonly stable?: Published | null; readonly list?: ReadonlyArray<Published>; readonly listStatus?: number }) => {
  const files = new Map<string, string>();
  const entry = (p: Published) => {
    const tag = p.tag ?? releaseTagFor(p.m.channel === "nightly" ? "nightly" : "release", p.m.version);
    const text = JSON.stringify(p.m);
    const signed = { "apollo-update.json": text, "apollo-update.json.minisig": minisign(Buffer.from(text), p.key, comment(p.m)) };
    for (const [name, body] of Object.entries(signed)) files.set(expectedAssetUrl(tag, name, REPO), body);
    const assets = [
      ...p.m.assets.map((a) => ({ name: a.name, size: a.size, digest: `sha256:${a.sha256}`, browser_download_url: expectedAssetUrl(tag, a.name, REPO) })),
      ...Object.entries(signed).map(([name, body]) => ({ name, size: body.length, digest: null, browser_download_url: expectedAssetUrl(tag, name, REPO) })),
    ];
    return { tag_name: tag, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, draft: p.draft ?? false, prerelease: p.prerelease ?? p.m.channel === "nightly", assets };
  };
  const stable = o.stable ? entry(o.stable) : null;
  const list = (o.list ?? []).map(entry);
  const requests: Array<string> = [];
  const fetchFn: Fetch = async (url) => {
    requests.push(url);
    if (url === `https://api.github.com/repos/${REPO}/releases/latest`) return stable ? Response.json(stable) : new Response("{}", { status: 404 });
    if (url === `https://api.github.com/repos/${REPO}/releases?per_page=30`) return o.listStatus ? new Response("{}", { status: o.listStatus }) : Response.json(list);
    const body = files.get(url);
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
  };
  return { fetchFn, requests };
};

const deps = (fetchFn: Fetch, over: Partial<CheckDeps> = {}): CheckDeps => ({
  fetchFn,
  keys: releaseKeys,
  nightlyKeys,
  channel: "nightly",
  running,
  teamId: TEAM,
  skipped: [],
  dbSchema: 20,
  now: 0,
  repo: REPO,
  ...over,
});

describe("nightly key", () => {
  it("is trusted on its own, separate from the release keys", () => {
    expect(nightlyKeys.configured).toBe(true);
    expect(nightlyTrustedKeys("", releaseKeys)).toMatchObject({ configured: false, reason: expect.stringMatching(/no nightly signing key/) });
    expect(nightlyTrustedKeys("not a key", releaseKeys).configured).toBe(false);
  });

  it("is refused when it is a release key (same id, or same key under another id)", () => {
    expect(nightlyTrustedKeys(releaseKey.publicLine, releaseKeys)).toMatchObject({ configured: false, reason: expect.stringMatching(/same as a release key/) });
    const raw = Buffer.from(releaseKey.publicLine, "base64");
    const sameKeyOtherId = Buffer.concat([raw.subarray(0, 2), Buffer.alloc(8, 7), raw.subarray(10)]).toString("base64");
    expect(nightlyTrustedKeys(sameKeyOtherId, releaseKeys).configured).toBe(false);
  });
});

describe("policy for the nightly channel", () => {
  const opts: DecideOptions = { channel: "nightly", tag: "nightly-1.3.1-nightly.20261110.42", teamId: TEAM, skipped: [], dbSchema: 20 };

  it("offers a nightly manifest from its nightly-<version> release", () => {
    expect(decide(nightlyManifest(), running, opts)).toMatchObject({ kind: "offer", asset: { name: "Apollo-1.3.1-nightly.20261110.42-arm64.zip" } });
  });

  it("never mixes channels or tags", () => {
    // A release manifest on the nightly lookup, a nightly manifest on the release lookup.
    expect(decide(manifest(), running, { ...opts, tag: "nightly-1.3.0" }).kind).toBe("refuse");
    expect(decide(nightlyManifest(), running, { ...opts, channel: "release", tag: "v1.3.1-nightly.20261110.42" }).kind).toBe("refuse");
    // The right channel, from the wrong release.
    expect(decide(nightlyManifest(), running, { ...opts, tag: "v1.3.1-nightly.20261110.42" }).kind).toBe("refuse");
    expect(decide(nightlyManifest(), running, { ...opts, tag: "nightly-1.3.1-nightly.20261109.41" }).kind).toBe("refuse");
  });

  it("still requires Developer ID on macOS (an ad-hoc nightly is never installed)", () => {
    const m = nightlyManifest();
    const adhoc = { ...m, assets: m.assets.map((a) => (a.platform === "darwin" ? { ...a, name: a.name.replace(/\.(zip|dmg)$/, "-adhoc.$1"), codeSigning: { kind: "adhoc" as const } } : a)) };
    expect(decide(adhoc, running, opts).kind).toBe("refuse");
  });
});

describe("checkForUpdate with nightlies", () => {
  it("offers a nightly signed with the nightly key to someone who follows nightlies", async () => {
    const g = github({ stable: { m: manifest({ build: 450 }), key: releaseKey }, list: [{ m: nightlyManifest(), key: nightlyKey }] });
    const r = await checkForUpdate(deps(g.fetchFn));
    expect(r.kind === "available" && r.offer.manifest.version).toBe("1.3.1-nightly.20261110.42");
    expect(r.kind === "available" && r.offer.url).toBe(`https://github.com/${REPO}/releases/download/nightly-1.3.1-nightly.20261110.42/Apollo-1.3.1-nightly.20261110.42-arm64.zip`);
  });

  it("never looks at nightlies for someone who follows stable releases", async () => {
    const g = github({ stable: { m: manifest({ build: 450 }), key: releaseKey }, list: [{ m: nightlyManifest(), key: nightlyKey }] });
    const r = await checkForUpdate(deps(g.fetchFn, { channel: "release" }));
    expect(r.kind === "available" && r.offer.manifest.version).toBe("1.3.0");
    expect(g.requests.some((u) => u.includes("releases?"))).toBe(false);
  });

  it("refuses a nightly-key signature on a stable release (the nightly key cannot reach stable followers)", async () => {
    // Someone with only the nightly key publishes a "stable" release, as release or nightly channel.
    for (const m of [manifest(), manifest({ channel: "nightly" })]) {
      const g = github({ stable: { m, key: nightlyKey, tag: "v1.3.0", prerelease: false } });
      const r = await checkForUpdate(deps(g.fetchFn, { channel: "release" }));
      expect(r.kind === "refused" && r.reason).toMatch(/does not trust|for the nightly channel/);
    }
  });

  it("refuses a nightly signed with the release key (each channel has exactly its own key)", async () => {
    const g = github({ list: [{ m: nightlyManifest(), key: releaseKey }] });
    const r = await checkForUpdate(deps(g.fetchFn));
    expect(r.kind === "refused" && r.reason).toMatch(/does not trust/);
  });

  it("offers the stable release when it is newer than the latest nightly", async () => {
    const g = github({ stable: { m: manifest({ build: 600 }), key: releaseKey }, list: [{ m: nightlyManifest({ build: 520 }), key: nightlyKey }] });
    const r = await checkForUpdate(deps(g.fetchFn));
    expect(r.kind === "available" && r.offer.manifest.channel).toBe("release");
  });

  it("is up to date when neither channel is newer, and says which build is latest", async () => {
    const g = github({ stable: { m: manifest({ build: 300 }), key: releaseKey }, list: [{ m: nightlyManifest({ build: 400 }), key: nightlyKey }] });
    expect(await checkForUpdate(deps(g.fetchFn))).toEqual({ kind: "up-to-date", latest: "1.3.1-nightly.20261110.42" });
  });

  it("takes only the newest nightly prerelease from the list, skipping drafts, non-nightly tags and stable releases", async () => {
    const older = nightlyManifest({ version: "1.3.1-nightly.20261109.41", build: 510 });
    const g = github({
      list: [
        { m: manifest({ version: "1.4.0", build: 900 }), key: releaseKey, tag: "v1.4.0", prerelease: true }, // a release candidate
        { m: nightlyManifest({ build: 530 }), key: nightlyKey, draft: true },
        { m: nightlyManifest({ build: 530 }), key: nightlyKey, prerelease: false, tag: "nightly-not-a-prerelease" },
        { m: older, key: nightlyKey },
      ],
    });
    const latest = await fetchLatestNightly(g.fetchFn, 0, REPO);
    expect(latest.kind === "ok" && latest.release.tag).toBe("nightly-1.3.1-nightly.20261109.41");
    const r = await checkForUpdate(deps(g.fetchFn));
    expect(r.kind === "available" && r.offer.manifest.build).toBe(510);
  });

  it("is not configured without a nightly key, and makes no request", async () => {
    const g = github({ stable: { m: manifest(), key: releaseKey } });
    const r = await checkForUpdate(deps(g.fetchFn, { nightlyKeys: nightlyTrustedKeys("", releaseKeys) }));
    expect(r.kind).toBe("not-configured");
    expect(g.requests).toEqual([]);
  });

  it("reports a rate limit on either lookup when nothing is offered (so the schedule backs off)", async () => {
    const g = github({ stable: { m: manifest({ build: 300 }), key: releaseKey }, listStatus: 429 });
    expect((await checkForUpdate(deps(g.fetchFn))).kind).toBe("rate-limited");
  });
});

describe("combineResults", () => {
  const upToDate: CheckResult = { kind: "up-to-date", latest: "1.2.0" };
  it("prefers an offer, then trouble, then up to date, then nothing", () => {
    expect(combineResults({ kind: "no-release" }, { kind: "no-release" })).toEqual({ kind: "no-release" });
    expect(combineResults({ kind: "no-release" }, upToDate)).toEqual(upToDate);
    expect(combineResults(upToDate, { kind: "error", message: "x" }).kind).toBe("error");
    expect(combineResults({ kind: "refused", reason: "r" }, { kind: "rate-limited", retryAt: 5 }).kind).toBe("rate-limited");
  });
});

describe("followed channel", () => {
  it("defaults to the running build's channel and keeps the user's choice", () => {
    expect(followedChannel(EMPTY_STATE, "release", true)).toBe("release");
    expect(followedChannel(EMPTY_STATE, "nightly", true)).toBe("nightly");
    expect(followedChannel(EMPTY_STATE, "local", true)).toBe("release");
    expect(followedChannel({ channel: "release" }, "nightly", true)).toBe("release");
    expect(followedChannel({ channel: "nightly" }, "release", true)).toBe("nightly");
  });

  it("falls back to stable releases when this build cannot verify nightlies", () => {
    expect(followedChannel({ channel: "nightly" }, "release", false)).toBe("release");
    expect(followedChannel(EMPTY_STATE, "nightly", false)).toBe("release");
  });

  it("is read back from state.json, and anything odd there means the default", () => {
    expect(parseState(JSON.stringify({ channel: "nightly" })).channel).toBe("nightly");
    for (const channel of ["beta", 1, null, { toString: "nightly" }]) expect(parseState(JSON.stringify({ channel })).channel).toBeNull();
    expect(parseState(null).channel).toBeNull();
  });
});

describe("initial channel (survives updates across channels)", () => {
  it("a fresh nightly install keeps following nightlies after it updates to a stable release", () => {
    // First start of a nightly build: the channel is saved before anything can update the app.
    let s = withInitialChannel(EMPTY_STATE, "nightly");
    expect(s.channel).toBe("nightly");
    s = afterCheck(s, { kind: "up-to-date", latest: null }, 1);
    // It accepted a newer stable release; the next launch runs a release build and reads state.json back.
    const relaunched = withInitialChannel(parseState(JSON.stringify(s)), "release");
    expect(relaunched.channel).toBe("nightly");
    expect(followedChannel(relaunched, "release", true)).toBe("nightly");
  });

  it("a fresh stable install keeps following stable releases if it ever runs a nightly build", () => {
    const s = withInitialChannel(EMPTY_STATE, "release");
    expect(followedChannel(withInitialChannel(parseState(JSON.stringify(s)), "nightly"), "nightly", true)).toBe("release");
  });

  it("never overrides a saved choice, and never pins for a local build or unknown build", () => {
    const chosen = { ...EMPTY_STATE, channel: "release" as const };
    expect(withInitialChannel(chosen, "nightly")).toBe(chosen);
    expect(withInitialChannel(EMPTY_STATE, "local")).toBe(EMPTY_STATE);
    expect(withInitialChannel(EMPTY_STATE, null)).toBe(EMPTY_STATE);
  });

  it("pins nightly even when this build cannot verify nightlies yet, so a later build that can follows them", () => {
    const s = withInitialChannel(EMPTY_STATE, "nightly");
    expect(followedChannel(s, "nightly", false)).toBe("release");
    expect(followedChannel(s, "release", true)).toBe("nightly");
  });
});

describe("staged bundle channel", () => {
  const job = { version: "1.3.1-nightly.20261110.42", build: 520, commit: "0123456789abcdef0123456789abcdef01234567", schemaVersion: 20 };
  const info = { ...job, bundleVersion: "520", channel: "nightly" };
  it("must be the job's channel (release when a job predates channels)", () => {
    expect(stagedProblems(info, { ...job, channel: "nightly" })).toEqual([]);
    expect(stagedProblems(info, { ...job, channel: "release" })).toEqual(['channel "nightly" != "release"']);
    expect(stagedProblems(info, job)).toEqual(['channel "nightly" != "release"']);
  });
});
