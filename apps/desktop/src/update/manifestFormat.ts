/**
 * The release manifest format (`apollo-update.json`, format 2): types, parsing and asset names.
 * Shared by the release tooling (scripts/release/manifest.ts re-exports it) and the in-app
 * updater, which only trusts a manifest after its minisign signature is verified (signature.ts).
 * No Node or Electron imports: pure functions only.
 */

/** Mirrors `Channel` in scripts/release/version.ts. */
export type Channel = "release" | "nightly" | "local";

export const MANIFEST_NAME = "apollo-update.json";
export const SIGNATURE_NAME = `${MANIFEST_NAME}.minisig`;
export const SUMS_NAME = "SHA256SUMS";
export const MANIFEST_FORMAT = 2;

/** The channels the updater can follow: stable releases, or nightlies (which also take newer stable releases). */
export type UpdateChannel = "release" | "nightly";

/**
 * Nightlies are published as prereleases tagged `nightly-<version>` (never `v*`, which is the
 * release tag namespace and triggers release builds), signed with the separate nightly key.
 */
export const NIGHTLY_TAG_PREFIX = "nightly-";

/** The one GitHub Release tag a manifest of `channel` and `version` may come from. */
export const releaseTagFor = (channel: UpdateChannel, version: string): string => (channel === "release" ? `v${version}` : `${NIGHTLY_TAG_PREFIX}${version}`);

export type Platform = "darwin" | "win32";
export type AssetKind = "zip" | "dmg" | "nsis";

/** Every release must carry exactly these platform/arch targets. */
export const RELEASE_TARGETS: ReadonlyArray<`${Platform}-${string}`> = ["darwin-arm64", "win32-x64", "win32-arm64"];

/**
 * The one file name an asset may have, derived from what the manifest says it is: version,
 * platform, arch, kind and signing. Builders name their files with it and every gate (merge,
 * sign, promote) requires it, so a name can never disagree with its manifest entry, and an
 * unsigned/ad-hoc file always says so in its name (the double marking):
 *   macOS    Apollo-<version>-<arch>[-adhoc].<zip|dmg>
 *   Windows  Apollo-<version>-win-<arch>[-unsigned]-setup.exe
 */
export const expectedAssetName = (version: string, a: Pick<ManifestAsset, "platform" | "arch" | "kind" | "codeSigning">): string =>
  a.platform === "darwin"
    ? `Apollo-${version}-${a.arch}${a.codeSigning.kind === "adhoc" ? "-adhoc" : ""}.${a.kind}`
    : `Apollo-${version}-win-${a.arch}${a.codeSigning.kind === "unsigned" ? "-unsigned" : ""}-setup.exe`;

/** Every asset whose name is not exactly expectedAssetName() of its own manifest entry. */
export const assetNameProblems = (m: Pick<Manifest, "version" | "assets">): Array<string> =>
  m.assets.flatMap((a) => {
    const expected = expectedAssetName(m.version, a);
    return a.name === expected ? [] : [`${a.name}: name disagrees with its entry (${a.platform}-${a.arch} ${a.kind}, ${a.codeSigning.kind}, version ${m.version}); expected ${expected}`];
  });

/** Name of a platform build's partial manifest, e.g. apollo-update.win32-x64.json. */
export const partialManifestName = (platform: Platform, arch: string) => `apollo-update.${platform}-${arch}.json`;

/**
 * How the app in an asset is code-signed.
 *  - macOS: `developer-id` (releasable) or `adhoc` (NOT releasable: no stable designated
 *    requirement, so TCC permissions reset on every update; Gatekeeper blocks it once quarantined).
 *  - Windows: `authenticode` (Azure Trusted Signing, future) or `unsigned` (allowed for now,
 *    with "-unsigned" in the file name; SmartScreen warns on first run).
 */
export type CodeSigning =
  | { readonly kind: "developer-id"; readonly team: string }
  | { readonly kind: "adhoc" }
  | { readonly kind: "authenticode"; readonly publisher: string }
  | { readonly kind: "unsigned" };

export interface ManifestAsset {
  readonly name: string;
  readonly platform: Platform;
  readonly arch: string;
  readonly kind: AssetKind;
  readonly size: number;
  readonly sha256: string;
  readonly codeSigning: CodeSigning;
  /** Oldest OS version the app runs on (macOS LSMinimumSystemVersion; Windows "10"). */
  readonly minOs: string;
}

export interface Manifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly version: string;
  readonly build: number;
  readonly commit: string;
  readonly channel: Channel;
  readonly schemaVersion: number;
  readonly publishedAt: string;
  readonly assets: ReadonlyArray<ManifestAsset>;
  readonly notes: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const PLATFORMS: ReadonlyArray<string> = ["darwin", "win32"];
const KINDS: Record<Platform, ReadonlyArray<string>> = { darwin: ["zip", "dmg"], win32: ["nsis"] };
const SIGNINGS: Record<Platform, ReadonlyArray<string>> = { darwin: ["developer-id", "adhoc"], win32: ["authenticode", "unsigned"] };

const isCodeSigning = (v: unknown, platform: Platform): v is CodeSigning => {
  if (!isObject(v) || typeof v.kind !== "string" || !SIGNINGS[platform].includes(v.kind)) return false;
  if (v.kind === "developer-id") return typeof v.team === "string" && /^[A-Z0-9]{10}$/.test(v.team);
  if (v.kind === "authenticode") return typeof v.publisher === "string" && v.publisher !== "";
  return true;
};

/** Parses and shape-checks a manifest (full or partial); throws with the first problem found. */
export const parseManifest = (text: string): Manifest => {
  const m: unknown = JSON.parse(text);
  const fail = (why: string): never => {
    throw new Error(`${MANIFEST_NAME}: ${why}`);
  };
  if (!isObject(m)) return fail("not an object");
  if (m.format !== MANIFEST_FORMAT) fail(`unsupported format ${String(m.format)}`);
  if (typeof m.version !== "string" || !m.version) fail("missing version");
  if (typeof m.build !== "number" || !Number.isSafeInteger(m.build) || m.build < 1) fail("bad build");
  if (typeof m.commit !== "string" || !/^[0-9a-f]{40}$/.test(m.commit)) fail("bad commit");
  if (m.channel !== "release" && m.channel !== "nightly" && m.channel !== "local") fail("bad channel");
  if (typeof m.schemaVersion !== "number") fail("bad schemaVersion");
  if (!Array.isArray(m.assets) || m.assets.length === 0) fail("no assets");
  const names = new Set<string>();
  for (const raw of m.assets as Array<unknown>) {
    if (!isObject(raw)) return fail("bad asset entry");
    const a = raw;
    const label = String(a.name);
    if (typeof a.name !== "string" || typeof a.arch !== "string" || !a.arch) fail(`bad asset entry ${label}`);
    if (typeof a.platform !== "string" || !PLATFORMS.includes(a.platform)) fail(`${label}: bad platform ${String(a.platform)}`);
    const platform = a.platform as Platform;
    if (typeof a.kind !== "string" || !KINDS[platform].includes(a.kind)) fail(`${label}: bad kind ${String(a.kind)} for ${platform}`);
    if (!isCodeSigning(a.codeSigning, platform)) fail(`${label}: bad codeSigning for ${platform}`);
    if (typeof a.minOs !== "string" || !a.minOs) fail(`${label}: missing minOs`);
    if (typeof a.size !== "number" || typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) fail(`bad asset ${label}`);
    if (/[/\\]/.test(a.name as string) || (a.name as string).startsWith(".") || (a.name as string).startsWith("apollo-update") || a.name === SUMS_NAME) {
      fail(`illegal asset name ${label}`);
    }
    if (names.has(a.name as string)) fail(`duplicate asset ${label}`);
    names.add(a.name as string);
  }
  return m as unknown as Manifest;
};

/** The platform-arch targets a manifest covers, e.g. ["darwin-arm64", "win32-x64"]. */
export const targetsOf = (m: Pick<Manifest, "assets">): Array<string> =>
  [...new Set(m.assets.map((a) => `${a.platform}-${a.arch}`))].sort();

