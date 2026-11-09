/**
 * Version scheme for desktop (and iOS build numbers). Pure functions; the CLI is stamp.ts.
 *
 * Desktop, decided in the update-pipeline design (§3.4):
 *  - The git tag `vX.Y.Z` on a `main` commit is the single source of truth for a release.
 *    Strict SemVer core only: no leading zeros, no pre-release/build suffix on tags.
 *  - A tag build stamps `X.Y.Z` (CFBundleShortVersionString) with channel `release`.
 *  - A `main` push (nightly) stamps `<next patch after the latest tag>-nightly.<YYYYMMDD>.<run>`
 *    with channel `nightly`, so a nightly always sorts above the release it follows and below
 *    the next one (SemVer pre-release ordering).
 *  - CFBundleVersion (the integer macOS compares) is `git rev-list --count <commit>`: monotonic
 *    along main's first-parent history, and identical for the nightly and the tag build of one
 *    commit. It does not depend on which workflow ran.
 *
 * iOS: CFBundleVersion is a UTC timestamp `YYYYMMDDHHMM`, the format `testflight.sh` already
 * uses locally (now also in UTC), so CI and local uploads share one increasing sequence.
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const NUM = "(0|[1-9]\\d{0,8})";
const TAG = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}$`);

/** `v1.2.3` → {1,2,3}; anything else (v1.2, v01.2.3, v1.2.3-rc.1, 1.2.3) → null. */
export const parseReleaseTag = (tag: string): SemVer | null => {
  const m = TAG.exec(tag);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
};

export const formatSemVer = (v: SemVer): string => `${v.major}.${v.minor}.${v.patch}`;

export const compareSemVer = (a: SemVer, b: SemVer): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/** The highest well-formed release tag among `tags` (others are ignored), or null. */
export const latestReleaseTag = (tags: ReadonlyArray<string>): { tag: string; version: SemVer } | null => {
  let best: { tag: string; version: SemVer } | null = null;
  for (const tag of tags) {
    const version = parseReleaseTag(tag.trim());
    if (version && (!best || compareSemVer(version, best.version) > 0)) best = { tag: tag.trim(), version };
  }
  return best;
};

/** UTC date as YYYYMMDD. */
export const utcDay = (date: Date): string =>
  `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;

/** UTC minute as YYYYMMDDHHMM: the iOS build number (see header). */
export const iosBuildNumber = (date: Date): string =>
  `${utcDay(date)}${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}`;

export const nightlyVersion = (latest: SemVer | null, date: Date, runNumber: number): string => {
  if (!Number.isSafeInteger(runNumber) || runNumber < 1) throw new Error(`invalid run number: ${runNumber}`);
  const base = latest ? { ...latest, patch: latest.patch + 1 } : { major: 0, minor: 0, patch: 1 };
  return `${formatSemVer(base)}-nightly.${utcDay(date)}.${runNumber}`;
};

export type Channel = "release" | "nightly" | "local";

export interface Stamp {
  readonly version: string;
  readonly channel: Channel;
  /** CFBundleVersion: a positive integer, as a string. */
  readonly bundleVersion: string;
  readonly commit: string;
}

export interface StampInput {
  /** GITHUB_REF, e.g. refs/tags/v1.2.3 or refs/heads/main; null outside CI. */
  readonly ref: string | null;
  readonly commit: string;
  /** GITHUB_RUN_NUMBER; null outside CI. */
  readonly runNumber: number | null;
  readonly commitCount: number;
  /** Tags reachable from the commit (`git tag --merged`). */
  readonly tags: ReadonlyArray<string>;
  readonly now: Date;
}

/**
 * What to stamp into a build. Throws (fails the job before anything is built) on a `v*` tag
 * that is not a strict release tag, or on CI refs that are neither main nor a release tag.
 */
export const resolveStamp = (input: StampInput): Stamp => {
  if (!/^[0-9a-f]{40}$/.test(input.commit)) throw new Error(`not a full commit sha: ${input.commit}`);
  if (!Number.isSafeInteger(input.commitCount) || input.commitCount < 1) throw new Error(`invalid commit count: ${input.commitCount}`);
  const bundleVersion = String(input.commitCount);
  const { ref } = input;
  if (ref?.startsWith("refs/tags/")) {
    const tag = ref.slice("refs/tags/".length);
    const version = parseReleaseTag(tag);
    if (!version) throw new Error(`tag ${tag} is not a release tag (expected vMAJOR.MINOR.PATCH, e.g. v0.1.0)`);
    return { version: formatSemVer(version), channel: "release", bundleVersion, commit: input.commit };
  }
  if (ref === "refs/heads/main") {
    if (input.runNumber === null) throw new Error("a main build needs GITHUB_RUN_NUMBER");
    const latest = latestReleaseTag(input.tags)?.version ?? null;
    return { version: nightlyVersion(latest, input.now, input.runNumber), channel: "nightly", bundleVersion, commit: input.commit };
  }
  if (ref === null) {
    return { version: `0.0.0-local+${input.commit.slice(0, 10)}`, channel: "local", bundleVersion, commit: input.commit };
  }
  throw new Error(`refusing to stamp a build for ${ref}: only refs/heads/main and refs/tags/v* are built`);
};
