/**
 * Anonymous reads of the public repository's latest GitHub Release, and downloads of its
 * assets. Nothing fetched here is trusted by itself: the manifest is trusted only after its
 * minisign signature verifies, and an asset only after its size and SHA-256 match that manifest.
 * GitHub's own asset `digest` is a cross-check, never a source of trust.
 *
 * The anonymous API allows ~60 requests an hour per IP; asset downloads do not count.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { RELEASES_REPO } from "./keys.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Generic, identifies the client and nothing about the user. */
export const USER_AGENT = "Apollo-Desktop-Updater";

export const latestReleaseUrl = (repo = RELEASES_REPO) => `https://api.github.com/repos/${repo}/releases/latest`;
export const releasesPageUrl = (repo = RELEASES_REPO) => `https://github.com/${repo}/releases`;

export interface ReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly url: string;
  /** `sha256:<hex>` when GitHub computed one. */
  readonly digest: string | null;
}

export interface Release {
  readonly tag: string;
  readonly htmlUrl: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: ReadonlyArray<ReleaseAsset>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Shape-checks GitHub's release JSON; throws on anything unexpected. */
export const parseRelease = (json: unknown): Release => {
  if (!isObject(json)) throw new Error("the release is not an object");
  const { tag_name: tag, html_url: htmlUrl, draft, prerelease, assets } = json;
  if (typeof tag !== "string" || typeof htmlUrl !== "string" || typeof draft !== "boolean" || typeof prerelease !== "boolean" || !Array.isArray(assets)) {
    throw new Error("the release is missing fields");
  }
  return {
    tag,
    htmlUrl,
    draft,
    prerelease,
    assets: assets.map((a: unknown) => {
      if (!isObject(a) || typeof a.name !== "string" || typeof a.size !== "number" || typeof a.browser_download_url !== "string") throw new Error("a release asset is malformed");
      return { name: a.name, size: a.size, url: a.browser_download_url, digest: typeof a.digest === "string" ? a.digest : null };
    }),
  };
};

/** The only URL an asset of `tag` may be downloaded from (GitHub then redirects to its storage). */
export const expectedAssetUrl = (tag: string, name: string, repo = RELEASES_REPO) =>
  `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;

export type LatestRelease =
  | { readonly kind: "ok"; readonly release: Release }
  /** No published (non-draft, non-prerelease) release yet. */
  | { readonly kind: "none" }
  | { readonly kind: "rate-limited"; readonly retryAt: number };

/** When a rate-limited GitHub answer says to come back (Retry-After, X-RateLimit-Reset), or in an hour. */
export const retryAt = (headers: Headers, now: number): number => {
  const after = Number(headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return now + after * 1000;
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset * 1000 > now) return reset * 1000;
  return now + 60 * 60_000;
};

export const fetchLatestRelease = async (fetchFn: Fetch, now: number, repo = RELEASES_REPO): Promise<LatestRelease> => {
  const response = await fetchFn(latestReleaseUrl(repo), {
    headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT, "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (response.status === 404) return { kind: "none" };
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
    return { kind: "rate-limited", retryAt: retryAt(response.headers, now) };
  }
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return { kind: "ok", release: parseRelease(await response.json()) };
};

/** Reads a response body, failing as soon as it is longer than `maxBytes`. */
const readCapped = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  if (!response.body) throw new Error("empty response");
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`the download is larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const get = async (fetchFn: Fetch, url: string, signal?: AbortSignal): Promise<Response> => {
  const response = await fetchFn(url, { headers: { "user-agent": USER_AGENT, accept: "application/octet-stream" }, redirect: "follow", ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  return response;
};

/** A small asset (the manifest, its signature) into memory, at most `maxBytes`. */
export const downloadSmall = async (fetchFn: Fetch, url: string, maxBytes: number): Promise<Uint8Array> =>
  readCapped(await get(fetchFn, url, AbortSignal.timeout(30_000)), maxBytes);

/**
 * Streams an asset to `path`, hashing as it goes. Fails (and leaves cleanup to the caller) when
 * it grows past `expected.size`, stalls for `stallMs`, is aborted, or ends with a size or
 * SHA-256 other than expected.
 */
export const downloadVerified = async (o: {
  readonly fetchFn: Fetch;
  readonly url: string;
  readonly path: string;
  readonly expected: { readonly size: number; readonly sha256: string };
  readonly onProgress?: (received: number, total: number) => void;
  readonly signal?: AbortSignal;
  readonly stallMs?: number;
}): Promise<void> => {
  const stall = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, stall.signal]) : stall.signal;
  let timer = setTimeout(() => stall.abort(new Error("the download stalled")), o.stallMs ?? 60_000);
  const fd = openSync(o.path, "wx");
  try {
    const response = await get(o.fetchFn, o.url, signal);
    if (!response.body) throw new Error("empty response");
    const hash = createHash("sha256");
    let received = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(new Error("the download stalled")), o.stallMs ?? 60_000);
      received += chunk.byteLength;
      if (received > o.expected.size) throw new Error(`the download is larger than the ${o.expected.size} bytes the manifest says`);
      hash.update(chunk);
      for (let off = 0; off < chunk.byteLength; ) off += writeSync(fd, chunk, off);
      o.onProgress?.(received, o.expected.size);
    }
    if (received !== o.expected.size) throw new Error(`downloaded ${received} bytes, the manifest says ${o.expected.size}`);
    const sha256 = hash.digest("hex");
    if (sha256 !== o.expected.sha256) throw new Error(`the download's SHA-256 is ${sha256}, the manifest says ${o.expected.sha256}`);
  } finally {
    clearTimeout(timer);
    closeSync(fd);
  }
};
