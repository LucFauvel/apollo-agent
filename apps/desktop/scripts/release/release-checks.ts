/**
 * What must be true of a GitHub release before CI signs it (stage `sign`) or promotes it to
 * the stable channel (stage `promote`). Pure: verify-release.ts gathers the facts (git, gh,
 * hashes, minisign) and this decides. Every problem is reported, not just the first.
 */
import { type CodeSigning, type Manifest, type Platform, RELEASE_TARGETS, targetsOf } from "./manifest.ts";
import { formatSemVer, parseReleaseTag } from "./version.ts";

/**
 * Release signing policy per platform. macOS: Developer ID only (ad-hoc is never released).
 * Windows: Authenticode, or UNSIGNED for now (no certificate yet; Luc's decision, see
 * RELEASE-SETUP.md). Remove "unsigned" here once Azure Trusted Signing is set up.
 */
export const RELEASE_SIGNING: Record<Platform, ReadonlyArray<CodeSigning["kind"]>> = {
  darwin: ["developer-id"],
  win32: ["authenticode", "unsigned"],
};

export type Stage = "sign" | "promote";

export interface ReleaseFacts {
  readonly tag: string;
  /** `git rev-parse <tag>^{commit}`, or null when the tag does not exist locally. */
  readonly tagCommit: string | null;
  /** The tag's commit is an ancestor of (or is) origin/main. */
  readonly onMain: boolean;
  readonly release: { readonly isDraft: boolean; readonly isPrerelease: boolean };
  readonly manifest: Manifest;
  /** compareAssets(): manifest vs SHA256SUMS vs recomputed hashes. */
  readonly assetProblems: ReadonlyArray<string>;
  /** The .minisig asset: absent, or verified against the configured public key. */
  readonly signature: "absent" | "valid" | "invalid";
  /** A successful main-branch (nightly) run of the desktop workflow exists for the same commit. */
  readonly nightlyGreen: boolean;
}

export const checkRelease = (facts: ReleaseFacts, stage: Stage): Array<string> => {
  const problems: Array<string> = [];
  const version = parseReleaseTag(facts.tag);
  if (!version) problems.push(`${facts.tag} is not a release tag (vMAJOR.MINOR.PATCH)`);
  if (!facts.tagCommit) problems.push(`tag ${facts.tag} does not exist in this checkout`);
  else if (!facts.onMain) problems.push(`tag ${facts.tag} (${facts.tagCommit}) is not on origin/main`);
  const m = facts.manifest;
  if (version && m.version !== formatSemVer(version)) problems.push(`manifest version ${m.version} != tag ${facts.tag}`);
  if (facts.tagCommit && m.commit !== facts.tagCommit) problems.push(`manifest commit ${m.commit} != tag commit ${facts.tagCommit}`);
  if (m.channel !== "release") problems.push(`manifest channel is ${m.channel}, not release`);
  // Every platform build, exactly once; each signed as its platform's release policy requires.
  const targets = targetsOf(m);
  for (const t of RELEASE_TARGETS) if (!targets.includes(t)) problems.push(`no ${t} build in the manifest`);
  for (const t of targets) if (!RELEASE_TARGETS.includes(t as `${Platform}-${string}`)) problems.push(`unexpected ${t} build in the manifest`);
  for (const a of m.assets) {
    const allowed = RELEASE_SIGNING[a.platform];
    if (!allowed.includes(a.codeSigning.kind)) problems.push(`${a.name} is ${a.codeSigning.kind}: a ${a.platform} release needs ${allowed.join(" or ")}`);
  }
  problems.push(...facts.assetProblems);

  if (stage === "sign") {
    if (!facts.release.isDraft) problems.push("the release is already published: only drafts are signed");
    // Never re-sign: a signature already there means someone else signed this draft.
    if (facts.signature !== "absent") problems.push(`the draft already has a signature (${facts.signature}); refusing to sign it again`);
  } else {
    if (facts.release.isDraft) problems.push("the release is still a draft: it must be signed and published by the tag workflow first");
    if (!facts.release.isPrerelease) problems.push("the release is not a prerelease (already stable?)");
    if (facts.signature !== "valid") problems.push(`the manifest signature is ${facts.signature}`);
    // Same-commit rule: stable only ships bytes of a commit that already passed as a nightly on main.
    if (!facts.nightlyGreen) problems.push(`no successful nightly (Desktop workflow, push to main) for ${m.commit}`);
  }
  return problems;
};

/** The minisign trusted comment: signed together with the manifest, so it cannot be swapped. */
export const trustedComment = (m: Pick<Manifest, "version" | "commit" | "build">): string =>
  `apollo-update version=${m.version} build=${m.build} commit=${m.commit}`;
