# Release pipeline: setup checklist and status

Everything below happens on GitHub or in Apple's portals and is **Luc's to do**: the workflows
in `.github/workflows/` never create environments, secrets or rulesets. Nothing here has run on
GitHub yet: the first run needs a push of this branch (Luc's go).

## 1. What the pipeline does

```
PR / push to main ── ci.yml ─────────── typecheck + test (no secrets)

push to main ─────── desktop.yml/nightly ─ ad-hoc signed build → smoke test → run artifact (14 days)
                                          "Apollo-<x.y.z>-nightly.<UTC day>.<run>-arm64-adhoc.zip/.dmg"

push tag vX.Y.Z ──── desktop.yml
  1. release-build     env release-build (no reviewer)   tag must be on origin/main; typecheck+test;
                                                         Developer ID sign + notarize (app + dmg);
                                                         smoke test = GATE
  2. draft-release     contents:write                    DRAFT release: zip, dmg, apollo-update.json, SHA256SUMS
  3. sign-and-publish  env release (Luc approves) ◀── THE ONLY HUMAN CLICK
                                                         re-verify draft; minisign the manifest; attest
                                                         provenance; publish as PRERELEASE (candidate)
manual ───────────── promote-to-stable.yml               re-verify (signature, hashes, tag on main) +
                                                         same-commit rule (green nightly of that commit);
                                                         prerelease → stable "latest". NO rebuild.

manual / tag v* ──── ios-testflight.yml  env release-build   apps/mobile/scripts/testflight.sh → TestFlight
```

- **Versions** (`apps/desktop/scripts/release/version.ts`, unit-tested): the tag `vX.Y.Z` on a
  `main` commit is the version (strict: no `v01.2.3`, no `-rc`). Nightlies are
  `<next patch after the latest tag>-nightly.<YYYYMMDD UTC>.<run number>`. `CFBundleVersion` is
  `git rev-list --count <commit>`, so it increases along `main` and is the same for the nightly
  and the tag build of one commit. Everything is stamped on the command line: no version bump is
  ever committed. `Contents/Resources/build-info.json` now carries `version`, `channel`
  (`release`/`nightly`/`local`), `bundleVersion` and `arch`.
- **iOS build number**: UTC `YYYYMMDDHHMM`, the same 12-digit format `testflight.sh` used, now in
  UTC locally too. UTC is ahead of North American time zones, so the sequence keeps increasing across the switch.
  `app.json` is only edited in the working copy, never committed.
- **Smoke test** (`apps/desktop/scripts/release/smoke.ts`): unpacks the *released zip*, seeds a
  database at schema 1 and at the schema just before the current one (bot, sessions, events, a
  memory with its search index, a skill), runs the packaged app's own executable in its
  screenshot mode (server → `/health` → UI loaded offscreen → capture → quit), asks `/health`
  from outside, and requires a clean exit, no leftover server, a non-empty capture and a database
  migrated to the build's schema with the seed intact. Verified locally on an ad-hoc build
  (1→19 and 18→19 pass; a build with a broken server bundle fails).
  **Gaps, on purpose stated loudly:** no tray, no visible window, no LaunchServices/Gatekeeper
  `open` launch, no provider CLI (none on CI), no tailnet (off in a fresh data dir). It does run
  the real packaged binary, not a simulation.

## 2. GitHub settings (Luc)

### 2.1 Environments (Settings → Environments)

| Environment | Protection | Deployment branches and tags | Holds |
|---|---|---|---|
| `release-build` | no reviewer | tags `v*` **and** branch `main` (iOS manual runs dispatch from main) | Developer ID, App Store Connect key, iOS signing |
| `release` | **Required reviewers: LucFauvel**; leave "Prevent self-review" **off** (Luc is the only approver, see §5) | tags `v*` only | the minisign secret key |

Why two: the build needs the signing certificates without a click, and the only human gate is
the manifest signature + publication (`sign-and-publish`). A build that nobody approves stays
a draft that no client can ever see.

### 2.2 Secrets and variables

`release-build` environment secrets:

| Secret | What | Where it comes from |
|---|---|---|
| `RELEASE_DEVELOPER_ID_P12` | base64 of the **Developer ID Application** `.p12` (cert + private key) | **Does not exist yet (P0).** §3.1 |
| `RELEASE_DEVELOPER_ID_P12_PASSWORD` | the password chosen when exporting it | you |
| `RELEASE_ASC_KEY_ID` | App Store Connect API key ID | `APOLLO_ASC_KEY_ID` in `~/.appstoreconnect/apollo.env` (or a new key, §3.3) |
| `RELEASE_ASC_ISSUER_ID` | issuer ID | `APOLLO_ASC_ISSUER_ID` in the same file |
| `RELEASE_ASC_KEY_P8` | the `.p8` file's content (PEM as is, or base64 of it) | `~/.appstoreconnect/private_keys/AuthKey_<ID>.p8` |
| `RELEASE_APPLE_DISTRIBUTION_P12` | base64 of the **Apple Distribution: Luc Fauvel (XA3R5NAN2C)** `.p12` | §3.2 |
| `RELEASE_CERT_PASSWORD` | its export password | you |
| `RELEASE_IOS_PROFILE_APP` *(optional)* | base64 App Store profile for `dev.ocx64.apollo.mobile` | §3.4 |
| `RELEASE_IOS_PROFILE_NSE` *(optional, with the one above)* | base64 App Store profile for `dev.ocx64.apollo.mobile.NotificationService` | §3.4 |

`release` environment secrets:

| Secret | What |
|---|---|
| `RELEASE_MINISIGN_SECRET` | the whole content of the minisign secret key file (§3.5) |
| `RELEASE_MINISIGN_PASSWORD` | its password (leave unset if the key was made with `-W`) |

Repository **variables** (Settings → Secrets and variables → Actions → Variables; not secret):

| Variable | Value |
|---|---|
| `RELEASE_MINISIGN_PUBLIC_KEY` | the public key line (the `RW…` line of `apollo.pub`). Repository level, because promote-to-stable has no environment. |
| `APOLLO_TEAM_ID` *(optional)* | defaults to `XA3R5NAN2C` |

Setting them from a terminal, if you prefer (one value at a time, never echoed):

```sh
base64 -i DeveloperID.p12 | gh secret set RELEASE_DEVELOPER_ID_P12 --env release-build -R LucFauvel/apollo-agent
gh secret set RELEASE_MINISIGN_SECRET --env release < ~/.minisign/apollo.key
gh variable set RELEASE_MINISIGN_PUBLIC_KEY -R LucFauvel/apollo-agent --body "$(tail -1 apollo.pub)"
```

### 2.3 Rulesets and repository settings

- **`main`** (the existing ruleset 26774107): keep "require PR" with your admin bypass; **add
  "Block force pushes" and "Restrict deletions"**. Optional: require signed commits.
- **New tag ruleset** on `refs/tags/v*`: restrict creations, updates and deletions (bypass: repository
  admin = you) and block force pushes. Tags are what trigger release builds.
- **Immutable releases: ON** (Settings → General → Releases). Published releases then can't have
  assets swapped or the tag moved. The pipeline uploads the signature *before* publishing.
- Actions → General: **"Require approval for all outside collaborators"** for fork PR runs; keep
  the default token **read-only** (already the case) and "Allow GitHub Actions to create and approve
  pull requests" **off**. Optional, if your account offers it: "Require actions to be pinned to a
  full-length commit SHA" (all workflows already comply).
- Recommended: Dependabot version updates for `github-actions`, so the pinned SHAs get bumped by PRs.

## 3. Credentials: where each one comes from

### 3.1 Developer ID Application certificate (P0, does not exist yet)
1. developer.apple.com → Certificates → **+** → *Developer ID Application* (Account Holder of team
   `XA3R5NAN2C` only; choose the G2 Sub-CA). It is free with the existing membership.
2. Create the CSR with Keychain Access → Certificate Assistant → *Request a Certificate From a
   Certificate Authority* (saved to disk), upload it, download the `.cer`, double-click to install.
3. Export it as in §3.2 (pick "Developer ID Application: Luc Fauvel (XA3R5NAN2C)").
Until it exists, **tag builds fail at their first step** ("Release secrets missing") and build nothing.

### 3.2 Exporting a certificate as `.p12` (Keychain Access)
1. Keychain Access → *login* keychain → *My Certificates*.
2. Expand the certificate ("Apple Distribution: Luc Fauvel (XA3R5NAN2C)", or the Developer ID one):
   it must show its private key underneath. Without a key, the export is useless (the key lives
   only on the Mac that made the CSR).
3. Right-click the **certificate** (not only the key) → *Export…* → format *Personal Information
   Exchange (.p12)* → set a strong password (that's `RELEASE_CERT_PASSWORD` /
   `RELEASE_DEVELOPER_ID_P12_PASSWORD`).
4. `base64 -i Cert.p12 | pbcopy` and paste it as the secret, then delete the `.p12` file.
Never export the "Apple Development: Luc Fauvel (S8U7W2FUXB)" certificate: it belongs to
Devolutions' team (`N592S9ASDB`) and must not go into this public repo's secrets.

### 3.3 App Store Connect API key (notarization + TestFlight)
- notarytool accepts an App Store Connect API key: a **Team** key needs `--key/--key-id/--issuer`
  (that's what the workflow passes through electron-builder: `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`, read in electron-builder 26.18's `MacTargetHelper.getNotarizeOptions`).
  Your `apollo.env` has an issuer ID, so it is a Team key and can be reused for both if it belongs
  to team `XA3R5NAN2C` and has the App Manager role (both still to confirm).
- Cleaner: a **second** key just for CI (App Store Connect → Users and Access → Integrations →
  Team Keys → *App Manager*), revocable without breaking your local TestFlight uploads.
- Variant, if notarization refuses the API key: `build-release.ts` also accepts
  `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` (an app-specific password from
  account.apple.com). The workflow does not wire them yet; it's three env lines in
  `desktop.yml` → "Build, sign (Developer ID) and notarize", plus the secrets.

### 3.4 iOS provisioning profiles (optional)
developer.apple.com → Profiles → **+** → *App Store Connect* distribution, one for
`dev.ocx64.apollo.mobile` and one for `dev.ocx64.apollo.mobile.NotificationService` (both with the
App Group and Push capabilities the app uses), certificate = the Apple Distribution one.
Download, `base64 -i X.mobileprovision | pbcopy`. Without them, export signing is automatic
(cloud-managed) through the API key, as `testflight.sh` does locally. If that refuses (cloud signing
can need an Admin-role key), add the profiles.

### 3.5 minisign release key (signs `apollo-update.json`)
```sh
minisign -G -p apollo.pub -s apollo.key        # set a password (or -W for none)
```
- Secret file content → `RELEASE_MINISIGN_SECRET`; password → `RELEASE_MINISIGN_PASSWORD`;
  the `RW…` line of `apollo.pub` → variable `RELEASE_MINISIGN_PUBLIC_KEY`. The same public key gets
  embedded in the app's updater (P2), together with a backup public key.
- Keep `apollo.key` + password in 1Password as the backup, then delete the local file. Generate the
  **backup** keypair the same way and keep it out of GitHub.
- Format: standard minisign Ed25519. The signing job verifies its own signature with the public
  key before uploading it, and the trusted comment binds `version`, `build` and `commit`
  (`apollo-update version=… build=… commit=…`).

## 4. Status: what works today, what waits

| Piece | Works now (after the first push) | Waits for |
|---|---|---|
| `ci.yml` checks | yes | — |
| Nightly ad-hoc build + smoke + artifact | yes (no secrets used) | — |
| Tag → release build | fails at once with "Release secrets missing", builds nothing | Developer ID cert (P0) + ASC key secrets + `release-build` env |
| Draft release | after a successful release build | same |
| Sign + publish (candidate) | stays a draft with "Signing not configured" | minisign key + `release` env with you as reviewer |
| Promote to stable | refuses without the public-key variable / a signed candidate | the above |
| iOS TestFlight | fails at once with the list of missing secrets | Apple Distribution .p12 + ASC key (+ profiles optional) |

Verified locally on this branch: root `pnpm typecheck && pnpm test`; a full ad-hoc
`build-release.ts` (verification of the re-extracted zip passed); the smoke test (pass + broken-build
fail); a minisign sign/verify/tamper round trip; `actionlint` + shellcheck on all workflows. **Not**
verifiable without GitHub and the credentials: Developer ID signing/notarization (that branch of
`build-release.ts` is untested), the environments' approval flow, attestations, the iOS job.

## 5. Open questions (checked against docs before relying on them; none blocks the code)

1. **KMS Ed25519 ↔ minisign**: could a cloud KMS key (no exportable secret, OIDC-authenticated
   from the job) produce minisign-compatible signatures? minisign signs a BLAKE2b-512 prehash of the
   file with Ed25519 (`ED` algorithm) and a second Ed25519 signature over signature+comment, so a
   KMS that does raw Ed25519 over arbitrary bytes should work with a small signer. That's a future
   upgrade, not needed now.
2. **Self-approval**: the `release` environment has one required reviewer, you, and you also push
   the tags. Required reviewers on a personal public repo with "Prevent self-review" **off** must
   let you approve your own run. Confirm on the first tag.
3. **Plan boundaries**: environments with required reviewers, tag rulesets and immutable releases
   on a personal account. The repo is public, which should qualify on Free. Confirm in Settings.
4. **SHA-pinning policy** ("require full-length commit SHA") on personal accounts: may be
   org/enterprise only. The workflows pin regardless.
5. **Immutable releases + promotion**: promote-to-stable flips `prerelease → latest` on an already
   published release. Immutability is documented for assets and tags; confirm that the
   prerelease/latest flags stay editable. If not: publish straight as latest in `sign-and-publish`
   and turn promote-to-stable into a "mark candidate approved" step.
6. **Runner images**: `macos-15` (desktop) and `macos-26` (iOS, needs an Xcode that builds Expo SDK
   58 / RN 0.88: you build with Xcode 27). Check the image's Xcode list before the first iOS run.
7. **minisign on `ubuntu-latest`** comes from apt (Ubuntu's package, 0.11+); the commands used
   (`-S -s -m -t -x`, `-V -P -m -x`, password on stdin) were checked locally with 0.12.
8. Tailnet addon under the hardened runtime: whether it needs
   `com.apple.security.cs.disable-library-validation` (`resources/entitlements.mac.plist` doesn't
   add it). The first Developer ID build's smoke test will show it.

## 6. Design notes for later phases (not implemented here)

- **Cold offline revoker key.** A third minisign key, generated and kept **offline** (never in CI,
  never on GitHub). It signs only two small files served **off GitHub** (e.g. a static host you
  control): a key-rotation list (which release public keys are valid) and a minimum-version file
  (versions below it are never installed). If the `release` environment, the minisign secret or
  the GitHub account is compromised, this key revokes the CI key and blocks bad versions without
  depending on GitHub.
- **External watcher.** A small job outside GitHub (or another account's scheduled check) polls the
  releases and tags of `LucFauvel/apollo-agent` and alerts you on any release, tag or environment
  approval you didn't trigger. The updater design assumes a compromise is noticed quickly.
- **No admin-capable token on day-to-day machines.** The `repo`-scoped `gh` token on this Mac can
  push tags, edit releases and approve deployments. Use a fine-grained token without
  administration/environments rights for daily work, and keep the admin session in a browser
  profile with a passkey.
- Attestations (`actions/attest-build-provenance`) are **audit only**; the app trusts the minisign
  signature, never the attestation.
