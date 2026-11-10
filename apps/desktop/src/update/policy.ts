/**
 * What the updater may offer, as pure functions over a manifest whose signature has already
 * been verified (minisign.ts) and what is known about the running app. Nothing here touches the
 * network or the disk.
 *
 * Rules:
 *  - The trusted comment is exactly `apollo-update version=… build=… commit=…` and agrees with
 *    the manifest (it is what binds the signature to that version, build and commit).
 *  - Only `release` manifests, from the release whose tag is `v<version>`, are ever offered.
 *    A release-channel app takes nothing else; a nightly (or local) app takes a release only
 *    when its build is strictly newer.
 *  - Never a downgrade: offered only when `manifest.build` > the running `bundleVersion`. An app
 *    without a bundleVersion (a local build) is never updated.
 *  - Never a schema downgrade: the manifest's `schemaVersion` must be ≥ the running build's, and
 *    the database must not be newer than it (the install engine's own gate, checkSchema).
 *  - The asset is the one for this platform and arch, named exactly as expectedAssetName says;
 *    on macOS it is the zip, Developer ID-signed by the pinned team.
 */
import { checkSchema } from "../install/lib.ts";
import { expectedAssetName, type Manifest, type ManifestAsset, type Channel } from "./manifestFormat.ts";

/** Largest asset the updater will download (the macOS zip is ~200 MB today). */
export const MAX_ASSET_BYTES = 2 * 1024 ** 3;

export interface RunningBuild {
  readonly version: string;
  readonly channel: Channel;
  /** CFBundleVersion (git commit count); null for builds that do not carry one. */
  readonly build: number | null;
  readonly schemaVersion: number;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** e.g. "15.3.1" on macOS (process.getSystemVersion()). */
  readonly osVersion: string;
}

export interface SignedFacts {
  readonly version: string;
  readonly build: number;
  readonly commit: string;
}

const COMMENT = /^apollo-update version=(\S+) build=([1-9]\d{0,15}) commit=([0-9a-f]{40})$/;

/** The trusted comment CI signs (scripts/release/release-checks.ts trustedComment), parsed; null if it is not one. */
export const parseTrustedComment = (comment: string): SignedFacts | null => {
  const m = COMMENT.exec(comment);
  if (!m) return null;
  const build = Number(m[2]);
  return Number.isSafeInteger(build) ? { version: m[1]!, build, commit: m[3]! } : null;
};

/** Every disagreement between the signed trusted comment and the manifest; empty when they agree. */
export const commentProblems = (comment: string, m: Pick<Manifest, "version" | "build" | "commit">): Array<string> => {
  const facts = parseTrustedComment(comment);
  if (!facts) return [`the trusted comment is not an apollo-update comment: ${JSON.stringify(comment.slice(0, 200))}`];
  const problems: Array<string> = [];
  if (facts.version !== m.version) problems.push(`the signature is for version ${facts.version}, the manifest says ${m.version}`);
  if (facts.build !== m.build) problems.push(`the signature is for build ${facts.build}, the manifest says ${m.build}`);
  if (facts.commit !== m.commit) problems.push(`the signature is for commit ${facts.commit}, the manifest says ${m.commit}`);
  return problems;
};

/** Numeric dotted-version comparison ("15.10" > "15.9"); missing parts count as 0. */
export const compareOsVersions = (a: string, b: string): number => {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

export type Decision =
  | { readonly kind: "offer"; readonly asset: ManifestAsset }
  | { readonly kind: "up-to-date" }
  /** Newer, but this build failed its health check here before: never offered again. */
  | { readonly kind: "skipped"; readonly build: number }
  | { readonly kind: "refuse"; readonly reason: string };

export interface DecideOptions {
  /** The GitHub release's tag (must be `v<manifest.version>`). */
  readonly tag: string;
  readonly teamId: string;
  /** Builds rolled back after a failed post-update health check. */
  readonly skipped: ReadonlyArray<number>;
  /** `pragma user_version` of the app's database, if known. */
  readonly dbSchema: number | null;
}

/** The asset kind the updater installs on each platform (the dmg is for people, not the updater). */
export const UPDATE_KIND: Partial<Record<NodeJS.Platform, ManifestAsset["kind"]>> = { darwin: "zip", win32: "nsis" };

/** Whether `m` (signature verified, comment checked) may be offered to `running`, and with which asset. */
export const decide = (m: Manifest, running: RunningBuild, o: DecideOptions): Decision => {
  if (running.build === null) return { kind: "refuse", reason: "this build has no build number (a local build), so it is never updated automatically" };
  if (m.channel !== "release") return { kind: "refuse", reason: `the release manifest is for the ${m.channel} channel` };
  if (o.tag !== `v${m.version}`) return { kind: "refuse", reason: `the manifest (version ${m.version}) does not belong to release ${o.tag}` };
  if (m.build <= running.build) return { kind: "up-to-date" };
  if (o.skipped.includes(m.build)) return { kind: "skipped", build: m.build };
  if (typeof m.schemaVersion !== "number" || !Number.isSafeInteger(m.schemaVersion) || m.schemaVersion < running.schemaVersion) {
    return { kind: "refuse", reason: `version ${m.version} reads database schema ${m.schemaVersion}, older than this build's ${running.schemaVersion}` };
  }
  const schema = checkSchema(o.dbSchema, m.schemaVersion, false);
  if (!schema.ok) return { kind: "refuse", reason: `version ${m.version} (schema ${m.schemaVersion}) cannot open the database here (schema ${o.dbSchema})` };

  const kind = UPDATE_KIND[running.platform];
  if (!kind) return { kind: "refuse", reason: `updates are not available on ${running.platform}` };
  const candidates = m.assets.filter((a) => a.platform === running.platform && a.arch === running.arch && a.kind === kind);
  if (candidates.length !== 1) {
    return { kind: "refuse", reason: candidates.length === 0 ? `version ${m.version} has no ${kind} for ${running.platform}-${running.arch}` : `version ${m.version} lists ${candidates.length} ${kind} assets for ${running.platform}-${running.arch}` };
  }
  const asset = candidates[0]!;
  if (asset.name !== expectedAssetName(m.version, asset)) return { kind: "refuse", reason: `asset ${asset.name} is not named ${expectedAssetName(m.version, asset)}` };
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES) return { kind: "refuse", reason: `asset ${asset.name} has an implausible size (${asset.size})` };
  if (running.platform === "darwin") {
    if (asset.codeSigning.kind !== "developer-id") return { kind: "refuse", reason: `asset ${asset.name} is ${asset.codeSigning.kind}-signed, not Developer ID` };
    if (asset.codeSigning.team !== o.teamId) return { kind: "refuse", reason: `asset ${asset.name} is signed by team ${asset.codeSigning.team}, not ${o.teamId}` };
  }
  if (compareOsVersions(running.osVersion, asset.minOs) < 0) return { kind: "refuse", reason: `version ${m.version} needs ${running.platform === "darwin" ? "macOS" : "Windows"} ${asset.minOs} or later` };
  return { kind: "offer", asset };
};
