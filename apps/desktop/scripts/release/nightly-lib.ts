/**
 * The nightly channel's publishing rules, as pure functions (the CLI is nightly.ts).
 *
 * Nightlies are signed with their OWN minisign key (NIGHTLY_MINISIGN_SECRET, environment
 * `nightly`), never the release key: the nightly job runs on every push to main without a human
 * gate, so its key must not be able to sign anything a stable-channel app accepts. The app
 * enforces that on its side (src/update/keys.ts nightlyTrustedKeys, check.ts); CI refuses to
 * sign with a nightly key that is a release key, so a misconfiguration fails loudly here too.
 */
import { BACKUP_PUBLIC_KEY, isUnsetKeySlot, NIGHTLY_PUBLIC_KEY, nightlyTrustedKeys, PRIMARY_PUBLIC_KEY } from "../../src/update/keys.ts";
import { type Manifest, NIGHTLY_TAG_PREFIX, releaseTagFor } from "../../src/update/manifestFormat.ts";
import { type MinisignPublicKey, parsePublicKey } from "../../src/update/minisign.ts";

export interface KeyInputs {
  /** The `RW…` line the job will verify its signature with (variable NIGHTLY_MINISIGN_PUBLIC_KEY). */
  readonly nightly: string;
  /** Repository variable RELEASE_MINISIGN_PUBLIC_KEY (may be empty). */
  readonly releaseVariable: string;
  /** What apps built from this commit embed (src/update/keys.ts). */
  readonly embedded?: { readonly primary: string; readonly backup: string; readonly nightly: string };
}

const sameKey = (a: MinisignPublicKey, b: MinisignPublicKey) =>
  a.id === b.id || a.key.export({ format: "der", type: "spki" }).equals(b.key.export({ format: "der", type: "spki" }));

/**
 * Problems (refuse to sign) and warnings (sign, but say so) about the nightly key. A problem: the
 * nightly key is missing, invalid, or is any release key (the variable's, the embedded primary or
 * backup). A warning: apps built from this commit do not embed this nightly key, so they will
 * not install what is about to be published.
 */
export const nightlyKeyProblems = (k: KeyInputs): { problems: Array<string>; warnings: Array<string> } => {
  const embedded = k.embedded ?? { primary: PRIMARY_PUBLIC_KEY, backup: BACKUP_PUBLIC_KEY, nightly: NIGHTLY_PUBLIC_KEY };
  const problems: Array<string> = [];
  const warnings: Array<string> = [];
  const releaseKeys: Array<MinisignPublicKey> = [];
  for (const [label, line] of [["RELEASE_MINISIGN_PUBLIC_KEY", k.releaseVariable], ["the embedded primary key", embedded.primary], ["the embedded backup key", embedded.backup]] as const) {
    if (isUnsetKeySlot(line)) continue;
    try {
      releaseKeys.push(parsePublicKey(line));
    } catch (error) {
      // Not this job's business to judge, but it cannot be compared either: say so.
      warnings.push(`${label} does not parse (${(error as Error).message}); the nightly key was not compared with it`);
    }
  }
  const nightly = nightlyTrustedKeys(k.nightly, { configured: true, keys: releaseKeys, notes: [] });
  if (!nightly.configured) {
    problems.push(isUnsetKeySlot(k.nightly) ? "NIGHTLY_MINISIGN_PUBLIC_KEY is not set" : `NIGHTLY_MINISIGN_PUBLIC_KEY: ${nightly.reason}`);
    return { problems, warnings };
  }
  if (isUnsetKeySlot(embedded.nightly)) {
    warnings.push("this commit's apps embed no nightly key (NIGHTLY_PUBLIC_KEY in src/update/keys.ts): no app installs this nightly until a build that embeds it");
  } else {
    try {
      if (!sameKey(parsePublicKey(embedded.nightly), nightly.keys[0]!)) warnings.push("NIGHTLY_PUBLIC_KEY in src/update/keys.ts is not NIGHTLY_MINISIGN_PUBLIC_KEY: apps built from this commit will refuse this nightly");
    } catch (error) {
      warnings.push(`NIGHTLY_PUBLIC_KEY in src/update/keys.ts does not parse (${(error as Error).message})`);
    }
  }
  return { problems, warnings };
};

/** What the merged nightly manifest must be before it is signed: channel, version and commit of this run. */
export const nightlyManifestProblems = (m: Pick<Manifest, "channel" | "version" | "commit">, expected: { version: string; commit: string }): Array<string> => {
  const problems: Array<string> = [];
  if (m.channel !== "nightly") problems.push(`manifest channel is ${m.channel}, not nightly`);
  if (m.version !== expected.version) problems.push(`manifest version ${m.version} != ${expected.version}`);
  if (!/^\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d*$/.test(m.version)) problems.push(`${m.version} is not a nightly version (X.Y.Z-nightly.YYYYMMDD.RUN)`);
  if (m.commit !== expected.commit) problems.push(`manifest commit ${m.commit} != ${expected.commit}`);
  return problems;
};

export const nightlyTag = (version: string) => releaseTagFor("nightly", version);

export interface ListedRelease {
  readonly tagName: string;
  readonly isPrerelease: boolean;
  readonly isDraft: boolean;
  readonly createdAt: string;
}

/**
 * The nightly releases to delete so only the newest `keep` remain. Only `nightly-*` prereleases
 * are ever candidates: a `v*` release, a draft or anything else is never touched.
 */
export const nightliesToPrune = (releases: ReadonlyArray<ListedRelease>, keep: number): Array<string> => {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error(`keep must be at least 1, got ${keep}`);
  return releases
    .filter((r) => r.tagName.startsWith(NIGHTLY_TAG_PREFIX) && r.isPrerelease && !r.isDraft)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(keep)
    .map((r) => r.tagName);
};
