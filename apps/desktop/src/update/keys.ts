/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
 * ║  THE UPDATER'S TRUST ANCHORS (minisign public keys; public data, never a secret key).     ║
 * ║                                                                                           ║
 * ║  PRIMARY: the release key CI signs `apollo-update.json` with (RELEASE-SETUP.md §3.5; the  ║
 * ║  repository variable RELEASE_MINISIGN_PUBLIC_KEY), key id 398569AC87A68D48.               ║
 * ║                                                                                           ║
 * ║  BACKUP: EMPTY SLOT. The offline backup keypair's public line (`RW…`) goes here; it is    ║
 * ║  kept out of GitHub on purpose. While the slot is empty it is ignored: it can never       ║
 * ║  match a signature. Fill it to let releases signed with the backup key (after a primary   ║
 * ║  key rotation) be accepted by builds already installed.                                   ║
 * ║                                                                                           ║
 * ║  NIGHTLY: a SEPARATE key (never the release key) that CI's nightly-publish job signs      ║
 * ║  nightly manifests with (RELEASE-SETUP.md §3.7; variable NIGHTLY_MINISIGN_PUBLIC_KEY).   ║
 * ║  It is trusted ONLY for nightly-channel manifests from `nightly-*` releases, and only     ║
 * ║  when the user follows nightlies; it can never verify a stable release. Empty slot = no   ║
 * ║  nightly channel in this build. A nightly key equal to a release key disables it.         ║
 * ║                                                                                           ║
 * ║  A signature verifies only against a real key listed here. With no usable primary key,    ║
 * ║  the updater is inert (no network at all; "Check for Updates…" says it is not set up).   ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
 */
import { type MinisignPublicKey, parsePublicKey } from "./minisign.ts";

/** The release signing key (minisign `RW…` line). */
export const PRIMARY_PUBLIC_KEY: string = "RWRIjaaHrGmFOQ5a1wL9XapMvpa4up75SUWrz3CobBGOESeNy8l0n4WH";
/** The offline backup key's `RW…` line. Empty until Luc fills it in: an empty slot is ignored. */
export const BACKUP_PUBLIC_KEY: string = "";

/** The nightly signing key's `RW…` line. Empty until Luc generates it (RELEASE-SETUP.md §3.7). */
export const NIGHTLY_PUBLIC_KEY: string = "";

/**
 * The Apple Developer team every macOS update must be Developer ID-signed by. RELEASE-SETUP.md
 * names it (Developer ID / Apple Distribution "Luc Fauvel (XA3R5NAN2C)"; `APOLLO_TEAM_ID`).
 */
export const TEAM_ID = "XA3R5NAN2C";

/** The public repository whose GitHub Releases carry signed builds. */
export const RELEASES_REPO = "LucFauvel/apollo-agent";

export type TrustedKeys =
  | { readonly configured: true; readonly keys: ReadonlyArray<MinisignPublicKey>; readonly notes: ReadonlyArray<string> }
  | { readonly configured: false; readonly reason: string };

/** An unfilled slot: empty, or a "PLACEHOLDER…" marker (not base64, so it could never parse as a key anyway). */
export const isUnsetKeySlot = (slot: string) => slot.trim() === "" || slot.trim().startsWith("PLACEHOLDER");
const isUnset = isUnsetKeySlot;

/**
 * The keys a release manifest may be signed with. Fails closed: without a valid primary key,
 * nothing is trusted. The backup slot is optional; unset, it is simply not a key. A filled slot
 * that does not parse disables the updater (a typo must not go unnoticed).
 */
export const trustedKeys = (primary: string = PRIMARY_PUBLIC_KEY, backup: string = BACKUP_PUBLIC_KEY): TrustedKeys => {
  if (isUnset(primary)) return { configured: false, reason: "this build has no release signing key embedded" };
  try {
    const keys = [parsePublicKey(primary)];
    const notes: Array<string> = [];
    if (isUnset(backup)) notes.push("backup key slot is empty (ignored)");
    else {
      const b = parsePublicKey(backup);
      if (b.id === keys[0]!.id) return { configured: false, reason: "the primary and backup keys are the same key" };
      keys.push(b);
    }
    return { configured: true, keys, notes };
  } catch (error) {
    return { configured: false, reason: `an embedded key is not valid (${error instanceof Error ? error.message : String(error)})` };
  }
};

/**
 * The keys a NIGHTLY manifest may be signed with: the nightly key alone. Fails closed when the
 * slot is empty or invalid, and when it is the same key as a release key (by id or by key
 * bytes): the nightly key lives in CI without a human gate, so it must never be able to sign
 * something a stable-channel app would accept, nor the other way round.
 */
export const nightlyTrustedKeys = (nightly: string = NIGHTLY_PUBLIC_KEY, release: TrustedKeys = trustedKeys()): TrustedKeys => {
  if (isUnset(nightly)) return { configured: false, reason: "this build has no nightly signing key embedded" };
  try {
    const key = parsePublicKey(nightly);
    if (release.configured) {
      const raw = (k: MinisignPublicKey) => k.key.export({ format: "der", type: "spki" }).toString("base64");
      if (release.keys.some((r) => r.id === key.id || raw(r) === raw(key))) return { configured: false, reason: "the nightly key is the same as a release key" };
    }
    return { configured: true, keys: [key], notes: [] };
  } catch (error) {
    return { configured: false, reason: `the embedded nightly key is not valid (${error instanceof Error ? error.message : String(error)})` };
  }
};
