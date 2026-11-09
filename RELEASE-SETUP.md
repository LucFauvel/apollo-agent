# Release pipeline: setup checklist and status

Everything below happens on GitHub, in Apple's portals or in Azure and is **Luc's to do**: the workflows
in `.github/workflows/` never create environments, secrets or rulesets. Nothing here has run on
GitHub yet: the first run needs a push of this branch (Luc's go).

## 1. What the pipeline does

```
PR / push to main ── ci.yml ─────────── typecheck + test (no secrets)

push to main ─────── desktop.yml nightlies (one shared version stamp) → each smoke-tested → run artifacts (14 days)
                       macOS arm64    ad-hoc signed   "Apollo-<x.y.z>-nightly.<UTC day>.<run>-arm64-adhoc.zip/.dmg"
                       Windows x64    unsigned        "Apollo-<…>-win-x64-unsigned-setup.exe"   (smoke on windows-latest)
                       Windows arm64  unsigned        "Apollo-<…>-win-arm64-unsigned-setup.exe" (built on x64, smoke on windows-11-arm)

push tag vX.Y.Z ──── desktop.yml
  1. release builds    env release-build (no reviewer)   tag must be on origin/main;
       macOS arm64                                       typecheck+test; Developer ID sign + notarize (app + dmg)
       Windows x64/arm64                                 NSIS installers; Authenticode when Azure Trusted Signing
                                                         is configured, else UNSIGNED (allowed by policy for now)
                                                         every platform's smoke test = GATE
  2. draft-release     contents:write                    merge the 3 partial manifests (re-hash everything; exactly
                                                         darwin-arm64 + win32-x64 + win32-arm64; macOS must be
                                                         Developer ID) → DRAFT release: installers, apollo-update.json, SHA256SUMS
  3. sign-and-publish  env release (Luc approves) ◀── THE ONLY HUMAN CLICK
                                                         re-verify draft; minisign the manifest; attest
                                                         provenance; publish as PRERELEASE (candidate)
manual ───────────── promote-to-stable.yml               re-verify (signature, hashes, tag on main) +
                                                         same-commit rule (green nightly of that commit);
                                                         prerelease → stable "latest". NO rebuild.

manual / tag v* ──── ios-testflight.yml  env release-build   apps/mobile/scripts/testflight.sh → TestFlight
```

- **Release manifest, format 2** (`apps/desktop/scripts/release/manifest.ts`, unit-tested): one
  `apollo-update.json` per release; every asset has `platform` (`darwin`/`win32`), `arch`, `kind`
  (`zip`/`dmg`/`nsis`), `size`, `sha256`, `codeSigning` (`developer-id`/`adhoc` on macOS,
  `authenticode`/`unsigned` on Windows) and `minOs`. Each platform build writes a partial manifest
  (`apollo-update.<platform>-<arch>.json`); the draft job merges them (`merge-manifests.ts`) and
  only the merged one is signed. Unsigned Windows files say so twice: `-unsigned` in the file name
  and `codeSigning.kind: "unsigned"`.
- **Versions** (`apps/desktop/scripts/release/version.ts`, unit-tested): the tag `vX.Y.Z` on a
  `main` commit is the version (strict: no `v01.2.3`, no `-rc`). Nightlies are
  `<next patch after the latest tag>-nightly.<YYYYMMDD UTC>.<run number>`. `CFBundleVersion` is
  `git rev-list --count <commit>`, so it increases along `main` and is the same for the nightly
  and the tag build of one commit; Windows uses it as the 4th part of the file version. Everything is stamped on the command line: no version bump is
  ever committed. `Contents/Resources/build-info.json` now carries `version`, `channel`
  (`release`/`nightly`/`local`), `bundleVersion` and `arch`.
- **iOS build number**: UTC `YYYYMMDDHHMM`, the same 12-digit format `testflight.sh` used, now in
  UTC locally too. UTC is ahead of North American time zones, so the sequence keeps increasing across the switch.
  `app.json` is only edited in the working copy, never committed.
- **Smoke test** (`apps/desktop/scripts/release/smoke.ts`): unpacks the *released zip* (macOS) or
  silently installs the *released installer* into a temp dir (Windows, `/S /D=…`, uninstalled
  afterwards), seeds a
  database at schema 1 and at the schema just before the current one (bot, sessions, events, a
  memory with its search index, a skill), runs the packaged app's own executable in its
  screenshot mode (server → `/health` → UI loaded offscreen → capture → quit), finds the port in
  the server's own `Listening on http://127.0.0.1:<port>` line, asks `/health` from outside, and
  requires a clean exit, the port to stop answering (no leftover server), a non-empty capture and
  a database migrated to the build's schema with the seed intact. Verified locally on macOS on an
  ad-hoc build (1→19 and 18→19 pass; a build with a broken server bundle fails).
  **Gaps, on purpose stated loudly:** no tray, no visible window, no LaunchServices/Gatekeeper
  `open` launch or SmartScreen, no provider CLI (none on CI), no tailnet (off in a fresh data
  dir; on Windows the addon is only checked to be a PE image for the right arch). It does run
  the real packaged binary, not a simulation.
  **Windows: not run anywhere yet.** The Windows path (silent install, `--disable-gpu`, env
  isolation through `USERPROFILE`) is written from electron-builder 26.18's NSIS templates and
  Electron's documented switches, and gets its first real run on GitHub. If the hosted runner
  can't render offscreen, the fallback is to drop the screenshot requirement on Windows only
  and keep migration + `/health` + clean exit (an `APOLLO_SMOKE_NO_CAPTURE`-style switch, not
  written yet, by design: first see what fails).

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
| `RELEASE_AZURE_TENANT_ID` *(future, Windows signing)* | Entra ID tenant of the Trusted Signing account | §3.6 |
| `RELEASE_AZURE_CLIENT_ID` *(future)* | app registration (service principal) allowed to sign | §3.6 |
| `RELEASE_AZURE_CLIENT_SECRET` *(future)* | its client secret | §3.6 |

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
| `APOLLO_AZURE_SIGN_ENDPOINT`, `APOLLO_AZURE_SIGN_ACCOUNT`, `APOLLO_AZURE_SIGN_PROFILE`, `APOLLO_AZURE_SIGN_PUBLISHER` *(future)* | Trusted Signing endpoint (e.g. `https://eus.codesigning.azure.net`), account name, certificate profile name, and the publisher name exactly as on the certificate (§3.6) |

Windows signing is all-or-nothing: with none of the seven Azure values set the Windows builds are
unsigned (a warning in the run, `-unsigned` in the file names); with only some set the build fails
with the list of what's missing.

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

### 3.6 Windows code signing: Azure Trusted Signing (recommended future path, not set up)
No Authenticode certificate exists, and none is needed to ship: the Windows installers are
**unsigned** for now (Luc's decision). Effects: SmartScreen shows "Windows protected your PC" on
first run until reputation builds, and an updater can't pin a publisher.
The cheap path when that matters is **Azure Trusted Signing** (Basic tier, about US$10/month,
Microsoft-managed certificates renewed for you, no hardware token):
1. Azure portal: create a *Trusted Signing account*, then complete *identity validation* (Individual
   validation is available for single developers; it can take days).
2. Create a *certificate profile* (Public Trust) → that's `APOLLO_AZURE_SIGN_PROFILE`; the account
   name and its endpoint region → `APOLLO_AZURE_SIGN_ACCOUNT` / `APOLLO_AZURE_SIGN_ENDPOINT`; the
   validated name → `APOLLO_AZURE_SIGN_PUBLISHER`.
3. Entra ID: an app registration with a client secret, granted the *Trusted Signing Certificate
   Profile Signer* role on the account → the three `RELEASE_AZURE_*` secrets.
`build-release-win.ts` then passes `win.azureSignOptions` to electron-builder 26.18 (its built-in
Trusted Signing support), checks the installer's Authenticode status is `Valid`, and the manifest
says `codeSigning: { kind: "authenticode", publisher }`. That path is **untested**. Once it works,
remove `"unsigned"` from `RELEASE_SIGNING.win32` in `release-checks.ts` so an unsigned Windows
build can no longer be released.

## 4. Status: what works today, what waits

| Piece | Works now (after the first push) | Waits for |
|---|---|---|
| `ci.yml` checks | yes | — |
| Nightly macOS ad-hoc build + smoke + artifact | yes (no secrets used) | — |
| Nightly Windows x64 + arm64 unsigned builds + smoke + artifacts | should, first real run on GitHub (§4.1) | — |
| Tag → release build | macOS fails at once with "Release secrets missing"; Windows builds unsigned; no draft (all platforms are required) | Developer ID cert (P0) + ASC key secrets + `release-build` env |
| Draft release | after a successful release build | same |
| Sign + publish (candidate) | stays a draft with "Signing not configured" | minisign key + `release` env with you as reviewer |
| Promote to stable | refuses without the public-key variable / a signed candidate | the above |
| iOS TestFlight | fails at once with the list of missing secrets | Apple Distribution .p12 + ASC key (+ profiles optional) |

Verified locally on this branch: root `pnpm typecheck && pnpm test`; a full ad-hoc
`build-release.ts` (verification of the re-extracted zip passed); the smoke test (pass + broken-build
fail); a minisign sign/verify/tamper round trip; `actionlint` + shellcheck on all workflows. **Not**
verifiable without GitHub and the credentials: Developer ID signing/notarization (that branch of
`build-release.ts` is untested), the environments' approval flow, attestations, the iOS job,
and every Windows step (§4.1).

### 4.1 Windows: what was proven, what wasn't

**Proven on this branch (from macOS, 2026-11-08):**
- **Tailnet addon, both arches:** `build.ps1`'s exact recipe (Go c-archive with llvm-mingw clang,
  Rust `*-pc-windows-gnullvm` with `+crt-static`, the libnode stub) cross-built
  `apollo_tailnet.node` for **x64 and arm64** with llvm-mingw 20261104 (macOS host build), Go
  1.27.3, Rust 1.97. The PE header check (`pe.ts`) reads them as x64 and arm64. CI builds them on
  `windows-latest` with the x86_64-host build of the same llvm-mingw release (pinned + SHA-256).
- **Installers, both arches:** electron-builder 26.18 with `electron-builder.win.yml` and
  `build-release-win.ts`'s flags produced `Apollo-Setup-<v>-x64.exe` and `Apollo-Setup-<v>-arm64.exe`
  (one-click, per-user NSIS); `apollo.exe` in `win-unpacked` / `win-arm64-unpacked` is x64 / arm64;
  `resources/build-info.json` carries the stamped version, channel, build number and **target**
  arch (new `APOLLO_BUILD_ARCH`, since x64 runners build arm64).
- **Nothing else native:** no node-gyp modules (`npmRebuild: false`; `node:sqlite` is built into
  Electron's Node), whisper/onnxruntime run in the web UI as WebAssembly (`@huggingface/transformers`
  is a web dependency; `onnxruntime-node` is not built), Electron 44.10.1 publishes
  `win32-x64` and `win32-arm64` zips.
So **nothing blocks win-arm64**: both architectures are built, neither is faked.

**Not proven (first run on GitHub):** `build-release-win.ts` itself on Windows (pnpm shell shims,
`build.ps1` under the runner's PowerShell, the Authenticode `NotSigned` check), the silent
install + launch + `/health` smoke test on `windows-latest` and `windows-11-arm`, and the hosted
`windows-11-arm` runner being available to this repo (§5). Luc's Windows 11 VM (Apple silicon,
so likely arm64) could run the arm64 smoke test before the first push; it was not used because
it is his work machine and installing Apollo there (HKCU, Start menu) needs his OK.

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
8. **Windows runners**: `windows-11-arm` (arm64 smoke test) must be available to this public
   repo (it was in public preview for public repositories); if not, the arm64 smoke jobs fail at
   queueing and the arm64 installer can't pass the release gate: drop `win32-arm64` from
   `RELEASE_TARGETS` (manifest.ts) and the two arm64 smoke jobs, or ask GitHub. Also: Electron
   offscreen capture on the hosted Windows session with `--disable-gpu` (the smoke test's
   assumption), and the `/D=` silent install path (electron-builder 26.18's `GetDParameter`).
9. Tailnet addon under the hardened runtime: whether it needs
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
