/**
 * Builds a Windows release artifact (NSIS installer) the way CI does, on Windows:
 *
 *   APOLLO_BUILD_VERSION=… APOLLO_BUILD_CHANNEL=release|nightly APOLLO_BUILD_NUMBER=… \
 *   APOLLO_BUILD_COMMIT=<sha> node apps/desktop/scripts/release/build-release-win.ts --arch x64|arm64 --out <dir>
 *
 * Same steps as `pnpm package:win` (UI, main process, build-info, server bundle), plus the tailnet
 * addon from apps/server/native/tailnet/build.ps1 (Go + Rust gnullvm + llvm-mingw; it builds
 * either architecture from x64 Windows), then electron-builder with electron-builder.win.yml for
 * ONE architecture, the version stamped on the command line (nothing is committed).
 *
 * Output in <dir>: Apollo-<version>-win-<arch>[-unsigned]-setup.exe, the partial manifest
 * apollo-update.win32-<arch>.json and SHA256SUMS.
 *
 * Code signing: UNSIGNED unless Azure Trusted Signing is fully configured (AZURE_TENANT_ID,
 * AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, APOLLO_AZURE_SIGN_ENDPOINT, APOLLO_AZURE_SIGN_ACCOUNT,
 * APOLLO_AZURE_SIGN_PROFILE, APOLLO_AZURE_SIGN_PUBLISHER), then electron-builder signs through
 * `win.azureSignOptions`. None set = unsigned (marked "-unsigned" in the file name and
 * `codeSigning.kind: "unsigned"`); some but not all set = error. The Azure path is UNTESTED.
 *
 * Verification (any failure exits 1, nothing is written to <dir>): the unpacked app's apollo.exe
 * and tailnet addon are PE images for <arch>; build-info.json carries the stamped version,
 * channel, build, commit and arch from a clean tree; the installer's Authenticode status matches
 * the signing mode.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildInfo } from "../install-app-lib.ts";
import { type CodeSigning, describeAsset, expectedAssetName, formatSums, type Manifest, MANIFEST_FORMAT, partialManifestName, SUMS_NAME } from "./manifest.ts";
import { peMachine } from "./pe.ts";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const archArg = arg("--arch");
const arch = archArg === "x64" || archArg === "arm64" ? archArg : fail("usage: build-release-win.ts --arch x64|arm64 --out <dir>");
const outDir = resolve(arg("--out") ?? fail("usage: build-release-win.ts --arch x64|arm64 --out <dir>"));
if (process.platform !== "win32") fail("Windows release builds run on Windows (the tailnet addon is built by build.ps1)");

const env = process.env;
const version = env.APOLLO_BUILD_VERSION || fail("APOLLO_BUILD_VERSION is not set (run release/stamp.ts first)");
const channelEnv = env.APOLLO_BUILD_CHANNEL || fail("APOLLO_BUILD_CHANNEL is not set");
const channel = channelEnv === "release" || channelEnv === "nightly" ? channelEnv : fail(`APOLLO_BUILD_CHANNEL=${channelEnv}: only release and nightly are built here`);
const bundleVersion = env.APOLLO_BUILD_NUMBER || fail("APOLLO_BUILD_NUMBER is not set");
if (!/^[1-9]\d*$/.test(bundleVersion)) fail(`APOLLO_BUILD_NUMBER=${bundleVersion} is not a positive integer`);
const commit = env.APOLLO_BUILD_COMMIT || fail("APOLLO_BUILD_COMMIT is not set");

const AZURE = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "APOLLO_AZURE_SIGN_ENDPOINT", "APOLLO_AZURE_SIGN_ACCOUNT", "APOLLO_AZURE_SIGN_PROFILE", "APOLLO_AZURE_SIGN_PUBLISHER"] as const;
const azureSet = AZURE.filter((k) => env[k]);
if (azureSet.length > 0 && azureSet.length < AZURE.length) {
  fail(`Azure Trusted Signing is partly configured; missing ${AZURE.filter((k) => !env[k]).join(", ")}`);
}
const codeSigning: CodeSigning = azureSet.length ? { kind: "authenticode", publisher: env.APOLLO_AZURE_SIGN_PUBLISHER! } : { kind: "unsigned" };

/** Runs a command without a shell (arguments with spaces stay intact); `undefined` env entries are removed. */
const run = (command: string, args: ReadonlyArray<string>, extraEnv: NodeJS.ProcessEnv = {}, options: { shell?: boolean } = {}) => {
  console.log(`▸ ${command} ${args.join(" ")}`);
  const merged = { ...env, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete merged[k];
  const r = spawnSync(command, args, { cwd: desktopDir, stdio: "inherit", env: merged, shell: options.shell ?? false });
  if (r.status !== 0) fail(`${command} failed (${r.signal ?? `exit ${r.status}`})`);
};
const stampEnv = { APOLLO_BUILD_ARCH: arch };

// 1. The parts `pnpm package:win` builds (pnpm is a .cmd shim on Windows: it needs a shell; no argument has spaces).
run("pnpm", ["--filter", "@apollo/web", "exec", "vite", "build", "--outDir", "../desktop/build/web", "--emptyOutDir"], {}, { shell: true });
run("pnpm", ["exec", "tsc", "-p", "."], {}, { shell: true });
run(process.execPath, ["scripts/write-build-info.ts"], stampEnv);
run(process.execPath, ["scripts/bundle-server.ts"]);
// 2. The tailnet addon for this architecture (→ ../server/native/tailnet/build/win-<arch>).
run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(desktopDir, "..", "server", "native", "tailnet", "build.ps1"), "-Arch", arch]);

// 3. Package one architecture, through electron-builder's own CLI script (no .cmd shim, no shell).
const builderCli = createRequire(join(desktopDir, "package.json")).resolve("electron-builder/cli.js");
const builderOut = join(desktopDir, "release", `ci-win-${arch}`);
rmSync(builderOut, { recursive: true, force: true });
run(
  process.execPath,
  [
    builderCli,
    "--win",
    "nsis",
    `--${arch}`,
    "--publish",
    "never",
    "--config",
    "electron-builder.win.yml",
    `-c.directories.output=${builderOut}`,
    `-c.extraMetadata.version=${version}`,
    // Windows file version x.y.z.<build>.
    `-c.buildVersion=${bundleVersion}`,
    ...(codeSigning.kind === "authenticode"
      ? [
          `-c.win.azureSignOptions.publisherName=${env.APOLLO_AZURE_SIGN_PUBLISHER}`,
          `-c.win.azureSignOptions.endpoint=${env.APOLLO_AZURE_SIGN_ENDPOINT}`,
          `-c.win.azureSignOptions.codeSigningAccountName=${env.APOLLO_AZURE_SIGN_ACCOUNT}`,
          `-c.win.azureSignOptions.certificateProfileName=${env.APOLLO_AZURE_SIGN_PROFILE}`,
        ]
      : []),
  ],
  // Unsigned: make sure no certificate from the environment is picked up.
  codeSigning.kind === "unsigned" ? { CSC_LINK: undefined, CSC_KEY_PASSWORD: undefined, WIN_CSC_LINK: undefined, WIN_CSC_KEY_PASSWORD: undefined } : {},
);

const installer = readdirSync(builderOut).find((f) => f.toLowerCase().endsWith(".exe") && f.includes(arch)) ?? fail(`no ${arch} installer in ${builderOut}`);
const unpacked = join(builderOut, arch === "x64" ? "win-unpacked" : `win-${arch}-unpacked`);
if (!existsSync(join(unpacked, "apollo.exe"))) fail(`no ${unpacked}\\apollo.exe`);

// 4. Verify.
const problems: Array<string> = [];
const machineOf = (path: string) => (existsSync(path) ? peMachine(readFileSync(path)) : "missing");
for (const [label, path] of [
  ["apollo.exe", join(unpacked, "apollo.exe")],
  ["tailnet addon", join(unpacked, "resources", "native", "apollo_tailnet.node")],
] as const) {
  const machine = machineOf(path);
  if (machine !== arch) problems.push(`${label} is ${machine ?? "not a PE image"}, expected ${arch}`);
}
const info = JSON.parse(readFileSync(join(unpacked, "resources", "build-info.json"), "utf8")) as BuildInfo;
if (info.version !== version) problems.push(`build-info version ${info.version} != ${version}`);
if (info.channel !== channel) problems.push(`build-info channel ${info.channel} != ${channel}`);
if (info.bundleVersion !== bundleVersion) problems.push(`build-info bundleVersion ${info.bundleVersion} != ${bundleVersion}`);
if (info.commit !== commit) problems.push(`build-info commit ${info.commit} != ${commit}`);
if (info.arch !== arch) problems.push(`build-info arch ${info.arch} != ${arch}`);
if (info.dirty) problems.push("the working tree was dirty when build-info.json was written");
const staging = mkdtempSync(join(tmpdir(), "apollo-release-win-"));
const name = expectedAssetName(version, { platform: "win32", arch, kind: "nsis", codeSigning });
const setupPath = join(staging, name);
copyFileSync(join(builderOut, installer), setupPath);
const authenticode = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${setupPath.replaceAll("'", "''")}').Status`], {
  encoding: "utf8",
});
const status = (authenticode.stdout ?? "").trim();
const expected = codeSigning.kind === "unsigned" ? "NotSigned" : "Valid";
if (status !== expected) problems.push(`installer Authenticode status is "${status}", expected ${expected}`);
if (problems.length) fail(`the Windows ${arch} build does not check out:\n  - ${problems.join("\n  - ")}`);

// 5. Partial manifest + SHA256SUMS.
const asset = await describeAsset(setupPath, { platform: "win32", arch, kind: "nsis", codeSigning, minOs: "10" });
const manifest: Manifest = {
  format: MANIFEST_FORMAT,
  version,
  build: Number(bundleVersion),
  commit,
  channel,
  schemaVersion: info.schemaVersion,
  publishedAt: new Date().toISOString(),
  assets: [asset],
  notes: "",
};
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(setupPath, join(outDir, name));
writeFileSync(join(outDir, partialManifestName("win32", arch)), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(outDir, SUMS_NAME), formatSums([asset]));
rmSync(staging, { recursive: true, force: true });
console.log(`✓ ${version} (${channel}, build ${bundleVersion}, win ${arch}, ${codeSigning.kind}) → ${outDir}`);
if (codeSigning.kind === "unsigned") console.log("  ⚠ unsigned: Windows SmartScreen warns on first run (Azure Trusted Signing: RELEASE-SETUP.md).");
