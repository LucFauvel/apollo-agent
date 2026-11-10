/**
 * One update check: the latest release → its manifest and signature → signature verified with
 * the embedded keys BEFORE the manifest is parsed → trusted comment agrees → policy (policy.ts).
 * Pure over an injected `fetch`, so tests drive it with fixtures and throwaway keys.
 */
import { commentProblems, decide, type RunningBuild } from "./policy.ts";
import { downloadSmall, expectedAssetUrl, type Fetch, fetchLatestRelease, type Release } from "./github.ts";
import type { TrustedKeys } from "./keys.ts";
import { type Manifest, MANIFEST_NAME, type ManifestAsset, parseManifest, SIGNATURE_NAME } from "./manifestFormat.ts";
import { verifyMinisign } from "./minisign.ts";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 4 * 1024;

export interface Offer {
  readonly manifest: Manifest;
  readonly asset: ManifestAsset;
  /** Where to download the asset (checked to be this release's own download URL). */
  readonly url: string;
  readonly release: Pick<Release, "tag" | "htmlUrl">;
}

export type CheckResult =
  | { readonly kind: "not-configured"; readonly reason: string }
  | { readonly kind: "no-release" }
  | { readonly kind: "up-to-date"; readonly latest: string | null }
  | { readonly kind: "skipped"; readonly version: string }
  | { readonly kind: "available"; readonly offer: Offer }
  | { readonly kind: "rate-limited"; readonly retryAt: number }
  /** A release exists but must not be installed (bad signature, policy): reported, never offered. */
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

export interface CheckDeps {
  readonly fetchFn: Fetch;
  readonly keys: TrustedKeys;
  readonly running: RunningBuild;
  readonly teamId: string;
  readonly skipped: ReadonlyArray<number>;
  readonly dbSchema: number | null;
  readonly now: number;
  readonly repo?: string;
}

const crossCheck = (release: Release, asset: ManifestAsset): string | null => {
  const listed = release.assets.find((a) => a.name === asset.name);
  if (!listed) return `release ${release.tag} has no asset ${asset.name}`;
  if (listed.size !== asset.size) return `GitHub lists ${asset.name} at ${listed.size} bytes, the manifest at ${asset.size}`;
  if (listed.digest && listed.digest.toLowerCase() !== `sha256:${asset.sha256}`) return `GitHub's digest for ${asset.name} disagrees with the manifest`;
  return null;
};

export const checkForUpdate = async (d: CheckDeps): Promise<CheckResult> => {
  if (!d.keys.configured) return { kind: "not-configured", reason: d.keys.reason };
  try {
    const latest = await fetchLatestRelease(d.fetchFn, d.now, d.repo);
    if (latest.kind === "none") return { kind: "no-release" };
    if (latest.kind === "rate-limited") return latest;
    const { release } = latest;
    // /releases/latest never returns these; checked anyway.
    if (release.draft || release.prerelease) return { kind: "refused", reason: `release ${release.tag} is a draft or prerelease` };
    const manifestAsset = release.assets.find((a) => a.name === MANIFEST_NAME);
    const signatureAsset = release.assets.find((a) => a.name === SIGNATURE_NAME);
    if (!manifestAsset || !signatureAsset) return { kind: "refused", reason: `release ${release.tag} has no signed ${MANIFEST_NAME}` };
    for (const a of [manifestAsset, signatureAsset]) {
      if (a.url !== expectedAssetUrl(release.tag, a.name, d.repo)) return { kind: "refused", reason: `release ${release.tag}: unexpected download URL for ${a.name}` };
    }
    const [manifestBytes, signatureBytes] = await Promise.all([
      downloadSmall(d.fetchFn, manifestAsset.url, MAX_MANIFEST_BYTES),
      downloadSmall(d.fetchFn, signatureAsset.url, MAX_SIGNATURE_BYTES),
    ]);

    // Nothing in the manifest is looked at before this.
    const verdict = verifyMinisign(manifestBytes, Buffer.from(signatureBytes).toString("utf8"), d.keys.keys);
    if (!verdict.ok) return { kind: "refused", reason: `release ${release.tag}: ${verdict.reason}` };
    let manifest: Manifest;
    try {
      manifest = parseManifest(Buffer.from(manifestBytes).toString("utf8"));
    } catch (error) {
      return { kind: "refused", reason: `release ${release.tag}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const comment = commentProblems(verdict.trustedComment, manifest);
    if (comment.length > 0) return { kind: "refused", reason: `release ${release.tag}: ${comment.join("; ")}` };

    const decision = decide(manifest, d.running, { tag: release.tag, teamId: d.teamId, skipped: d.skipped, dbSchema: d.dbSchema });
    switch (decision.kind) {
      case "up-to-date":
        return { kind: "up-to-date", latest: manifest.version };
      case "skipped":
        return { kind: "skipped", version: manifest.version };
      case "refuse":
        return { kind: "refused", reason: decision.reason };
      case "offer": {
        const problem = crossCheck(release, decision.asset);
        if (problem) return { kind: "refused", reason: problem };
        const url = release.assets.find((a) => a.name === decision.asset.name)!.url;
        if (url !== expectedAssetUrl(release.tag, decision.asset.name, d.repo)) return { kind: "refused", reason: `unexpected download URL for ${decision.asset.name}` };
        return { kind: "available", offer: { manifest, asset: decision.asset, url, release: { tag: release.tag, htmlUrl: release.htmlUrl } } };
      }
    }
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
};
