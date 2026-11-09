/**
 * Builds the macOS release artifacts the way CI does, from a clean checkout:
 *
 *   APOLLO_BUILD_VERSION=… APOLLO_BUILD_CHANNEL=release|nightly APOLLO_BUILD_NUMBER=… \
 *   APOLLO_BUILD_COMMIT=<sha> node apps/desktop/scripts/release/build-release.ts --out <dir>
 *
 * Output in <dir>: Apollo-<version>-arm64[-adhoc].zip (ditto, what the future updater consumes),
 * Apollo-<version>-arm64[-adhoc].dmg (for humans), apollo-update.json (manifest, unsigned) and
 * SHA256SUMS. The same build path as `pnpm package`/`install:app` (build:package, then
 * electron-builder), with the version stamped on the command line: nothing is committed.
 *
 * Code signing (APOLLO_CODESIGN):
 *  - `adhoc` (default): `identity: "-"`, no hardened runtime. NOT RELEASABLE: Gatekeeper blocks
 *    it once quarantined and macOS forgets permissions (microphone) on every update. Files get
 *    an `-adhoc` suffix and the manifest says `codeSigning.kind: "adhoc"`.
 *  - `developer-id`: electron-builder imports CSC_LINK/CSC_KEY_PASSWORD (a "Developer ID
 *    Application" .p12), hardened runtime with resources/entitlements.mac.plist, and notarizes
 *    when APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER are set. Needs APOLLO_TEAM_ID (pinned
 *    and verified after the build). UNTESTED until the Developer ID certificate exists.
 *
 * Verification after the build (any failure exits 1, nothing is written to <dir>):
 * the zip re-extracts with `ditto -x -k`, `codesign --verify --deep --strict` passes, the
 * Info.plist and Contents/Resources/build-info.json carry the stamped version, build and commit,
 * the tree was clean, and (developer-id) the team matches, plus `spctl` when notarized.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildInfo } from "../install-app-lib.ts";
import { type CodeSigning, describeAsset, formatSums, type Manifest, MANIFEST_NAME, SUMS_NAME } from "./manifest.ts";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ARCH = "arm64";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const outArg = process.argv.indexOf("--out");
const outDir = outArg > 0 && process.argv[outArg + 1] ? resolve(process.argv[outArg + 1]!) : fail("usage: build-release.ts --out <dir>");
if (process.platform !== "darwin" || process.arch !== ARCH) fail(`release builds are ${ARCH} macOS only (this is ${process.platform}/${process.arch})`);

const env = process.env;
const version = env.APOLLO_BUILD_VERSION || fail("APOLLO_BUILD_VERSION is not set (run release/stamp.ts first)");
const channelEnv = env.APOLLO_BUILD_CHANNEL || fail("APOLLO_BUILD_CHANNEL is not set");
const channel = channelEnv === "release" || channelEnv === "nightly" ? channelEnv : fail(`APOLLO_BUILD_CHANNEL=${channelEnv}: only release and nightly are built here`);
const bundleVersion = env.APOLLO_BUILD_NUMBER || fail("APOLLO_BUILD_NUMBER is not set");
if (!/^[1-9]\d*$/.test(bundleVersion)) fail(`APOLLO_BUILD_NUMBER=${bundleVersion} is not a positive integer`);
const commit = env.APOLLO_BUILD_COMMIT || fail("APOLLO_BUILD_COMMIT is not set");
const signingMode = env.APOLLO_CODESIGN || "adhoc";
if (signingMode !== "adhoc" && signingMode !== "developer-id") fail(`APOLLO_CODESIGN=${signingMode} is not adhoc or developer-id`);
const team = signingMode === "developer-id" ? env.APOLLO_TEAM_ID || fail("developer-id signing needs APOLLO_TEAM_ID") : null;
if (signingMode === "developer-id" && (!env.CSC_LINK || !env.CSC_KEY_PASSWORD)) fail("developer-id signing needs CSC_LINK and CSC_KEY_PASSWORD");
const notarize = signingMode === "developer-id" && Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);
const codeSigning: CodeSigning = team ? { kind: "developer-id", team } : { kind: "adhoc" };
// CFBundleShortVersionString must be numeric; the full (pre-release) version is in build-info.json.
const shortVersion = /^(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? fail(`APOLLO_BUILD_VERSION=${version} does not start with X.Y.Z`);

const run = (command: string, args: ReadonlyArray<string>, extraEnv: NodeJS.ProcessEnv = {}, cwd = desktopDir) => {
  console.log(`▸ ${command} ${args.join(" ")}`);
  const r = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...env, ...extraEnv } });
  if (r.status !== 0) fail(`${command} failed (${r.signal ?? `exit ${r.status}`})`);
};
const capture = (command: string, args: ReadonlyArray<string>) => {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

// 1. Build (the same script `pnpm package` runs), with the stamp in the environment.
const pnpmExec = env.npm_execpath;
const pnpm = !pnpmExec ? ["pnpm"] : /\.[cm]?js$/.test(pnpmExec) ? [process.execPath, pnpmExec] : [pnpmExec];
run(pnpm[0]!, [...pnpm.slice(1), "build:package"]);

// 2. Package. Its own output directory, so stale local builds in release/ never get picked up.
const builderOut = join(desktopDir, "release", "ci");
rmSync(builderOut, { recursive: true, force: true });
run(
  join(desktopDir, "node_modules", ".bin", "electron-builder"),
  [
    "--mac",
    "dmg",
    `--${ARCH}`,
    "--publish",
    "never",
    `-c.directories.output=${builderOut}`,
    `-c.extraMetadata.version=${version}`,
    `-c.mac.bundleShortVersion=${shortVersion}`,
    `-c.mac.bundleVersion=${bundleVersion}`,
    ...(signingMode === "adhoc"
      ? ["-c.mac.identity=-", "-c.mac.hardenedRuntime=false"]
      : [
          "-c.mac.hardenedRuntime=true",
          "-c.mac.entitlements=resources/entitlements.mac.plist",
          "-c.mac.entitlementsInherit=resources/entitlements.mac.plist",
          `-c.mac.notarize=${notarize}`,
        ]),
  ],
  signingMode === "adhoc" ? { CSC_IDENTITY_AUTO_DISCOVERY: "false", CSC_LINK: "", CSC_KEY_PASSWORD: "" } : {},
);

const appPath = join(builderOut, `mac-${ARCH}`, "Apollo.app");
if (!existsSync(appPath)) fail(`no ${appPath}`);
const dmg = readdirSync(builderOut).find((f) => f.endsWith(".dmg")) ?? fail(`no .dmg in ${builderOut}`);

// 3. Zip with ditto (keeps framework symlinks and signatures; what the updater will unpack).
const suffix = signingMode === "adhoc" ? "-adhoc" : "";
const base = `Apollo-${version}-${ARCH}${suffix}`;
const staging = mkdtempSync(join(tmpdir(), "apollo-release-"));
const zipPath = join(staging, `${base}.zip`);
const dmgPath = join(staging, `${base}.dmg`);
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
copyFileSync(join(builderOut, dmg), dmgPath);

// 4. Verify what was zipped, not what is on disk.
const check = mkdtempSync(join(tmpdir(), "apollo-verify-"));
run("ditto", ["-x", "-k", zipPath, check]);
const app = join(check, "Apollo.app");
const problems: Array<string> = [];
const sig = capture("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
if (!sig.ok) problems.push(`codesign --verify failed:\n${sig.out}`);
const details = capture("codesign", ["-dv", "--verbose=4", app]).out;
const plist = (key: string) => capture("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", join(app, "Contents", "Info.plist")]).out.trim();
if (plist("CFBundleShortVersionString") !== shortVersion) problems.push(`CFBundleShortVersionString ${plist("CFBundleShortVersionString")} != ${shortVersion}`);
if (plist("CFBundleVersion") !== bundleVersion) problems.push(`CFBundleVersion ${plist("CFBundleVersion")} != ${bundleVersion}`);
if (plist("CFBundleIdentifier") !== "dev.apollo.desktop") problems.push(`CFBundleIdentifier ${plist("CFBundleIdentifier")}`);
const info = JSON.parse(readFileSync(join(app, "Contents", "Resources", "build-info.json"), "utf8")) as BuildInfo;
if (info.version !== version) problems.push(`build-info version ${info.version} != ${version}`);
if (info.channel !== channel) problems.push(`build-info channel ${info.channel} != ${channel}`);
if (info.bundleVersion !== bundleVersion) problems.push(`build-info bundleVersion ${info.bundleVersion} != ${bundleVersion}`);
if (info.commit !== commit) problems.push(`build-info commit ${info.commit} != ${commit}`);
if (info.dirty) problems.push("the working tree was dirty when build-info.json was written");
if (!existsSync(join(app, "Contents", "Resources", "native", "apollo_tailnet.node"))) problems.push("the tailnet addon is missing");
if (team) {
  if (!new RegExp(`^TeamIdentifier=${team}$`, "m").test(details)) problems.push(`TeamIdentifier is not ${team}:\n${details}`);
  if (!/flags=.*runtime/.test(details)) problems.push("hardened runtime is off");
  if (notarize) {
    const gk = capture("spctl", ["-a", "-vv", "-t", "exec", app]);
    if (!gk.ok) problems.push(`spctl rejects the notarized app:\n${gk.out}`);
  }
} else if (!/Signature=adhoc/.test(details)) problems.push(`expected an ad-hoc signature:\n${details}`);
const minMacos = plist("LSMinimumSystemVersion") || "unknown";
rmSync(check, { recursive: true, force: true });
if (problems.length) fail(`the built app does not check out:\n  - ${problems.join("\n  - ")}`);

// 5. Manifest + SHA256SUMS (the manifest is signed later, locally, by `pnpm release:publish`).
const assets = [await describeAsset(zipPath, ARCH), await describeAsset(dmgPath, ARCH)];
const manifest: Manifest = {
  format: 1,
  version,
  build: Number(bundleVersion),
  commit,
  channel,
  schemaVersion: info.schemaVersion,
  minMacos,
  publishedAt: new Date().toISOString(),
  codeSigning,
  assets,
  notes: "",
};
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const a of assets) copyFileSync(join(staging, a.name), join(outDir, a.name));
writeFileSync(join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(outDir, SUMS_NAME), formatSums(assets));
rmSync(staging, { recursive: true, force: true });
console.log(`✓ ${version} (${channel}, build ${bundleVersion}, ${codeSigning.kind}) → ${outDir}`);
if (codeSigning.kind === "adhoc") console.log("  ⚠ ad-hoc signed: NOT RELEASABLE until a Developer ID certificate is configured (RELEASE-SETUP.md).");
// The unpacked app stays at release/ci/mac-arm64/Apollo.app for the smoke test.
console.log(`  app for the smoke test: ${appPath}`);
