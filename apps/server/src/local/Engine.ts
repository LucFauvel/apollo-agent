import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Hardware, LlamaBackend } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import { run } from "./Hardware.ts";

/** A llama.cpp release asset, as GitHub lists it. */
export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  readonly size: number;
  /** `sha256:<hex>` */
  readonly digest: string | null;
}

export interface Release {
  readonly tag: string;
  readonly assets: ReadonlyArray<ReleaseAsset>;
}

export type ConcreteBackend = Exclude<LlamaBackend, "auto">;

/** What `auto` means on this machine. */
export const recommendBackend = (hardware: Hardware): ConcreteBackend => {
  const vendors = new Set(hardware.gpus.map((g) => g.vendor));
  if (hardware.platform === "darwin") return hardware.arch === "arm64" ? "metal" : "cpu";
  if (vendors.has("nvidia") && hardware.cudaVersion) return "cuda";
  if (vendors.has("nvidia") || vendors.has("amd") || vendors.has("intel")) return "vulkan";
  return "cpu";
};

const versionOf = (text: string) => text.split(".").map(Number) as [number, number];
const atMost = ([a, b]: [number, number], [c, d]: [number, number]) => a < c || (a === c && b <= d);

/**
 * The archives to install for a backend: the llama.cpp build, plus the CUDA
 * runtime for CUDA builds. CUDA picks the newest toolkit the driver supports.
 * Names look like `llama-b12119-bin-ubuntu-cuda-13.4-x64.tar.gz`.
 */
export const selectAssets = (
  release: Release,
  hardware: Hardware,
  backend: ConcreteBackend,
): ReadonlyArray<ReleaseAsset> | null => {
  const cpu = hardware.arch === "arm64" ? "arm64" : hardware.arch === "x64" ? "x64" : null;
  if (!cpu) return null;
  const tag = release.tag;
  const byName = (pattern: RegExp) => release.assets.filter((a) => pattern.test(a.name));
  const one = (pattern: RegExp) => byName(pattern)[0] ?? null;
  const ext = hardware.platform === "win32" ? "zip" : "tar\\.gz";
  const os = hardware.platform === "win32" ? "win" : hardware.platform === "darwin" ? "macos" : "ubuntu";

  if (hardware.platform === "darwin") {
    const asset = one(new RegExp(`^llama-${tag}-bin-macos-${cpu}\\.tar\\.gz$`));
    return asset && (backend === "metal" || backend === "cpu") ? [asset] : null;
  }
  if (backend === "cpu") {
    const asset = one(new RegExp(`^llama-${tag}-bin-${os}-${os === "win" ? `cpu-${cpu}` : cpu}\\.${ext}$`));
    return asset ? [asset] : null;
  }
  if (backend === "vulkan" || backend === "rocm") {
    const pattern =
      backend === "vulkan"
        ? new RegExp(`^llama-${tag}-bin-${os}-vulkan-${cpu}\\.${ext}$`)
        : new RegExp(`^llama-${tag}-bin-${os}-rocm-[\\d.]+-${cpu}\\.${ext}$`);
    const asset = one(pattern);
    return asset ? [asset] : null;
  }
  if (backend === "cuda") {
    const driver = hardware.cudaVersion ? versionOf(hardware.cudaVersion) : null;
    if (!driver) return null;
    const builds = byName(new RegExp(`^llama-${tag}-bin-${os}-cuda-(\\d+\\.\\d+)-${cpu}\\.${ext}$`))
      .map((asset) => ({ asset, version: versionOf(/cuda-(\d+\.\d+)/.exec(asset.name)![1]!) }))
      // The driver runs any toolkit of its major version or older.
      .filter(({ version }) => version[0] <= driver[0])
      .sort((a, b) => (atMost(a.version, b.version) ? 1 : -1));
    const best = builds[0];
    if (!best) return null;
    const version = best.version.join(".");
    const runtime = one(new RegExp(`^cudart-llama-(?:${tag}-)?bin-${os}-cuda-${version.replace(".", "\\.")}-${cpu}\\.${ext}$`));
    return runtime ? [best.asset, runtime] : [best.asset];
  }
  return null;
};

const GITHUB = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10";

/** The newest numbered build (`b12119`) that has assets for this machine and backend. */
export const latestRelease = (hardware: Hardware, backend: ConcreteBackend) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(GITHUB, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        headers: { accept: "application/vnd.github+json", "user-agent": "apollo-desktop" },
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const releases = (await response.json()) as Array<{
        tag_name: string;
        draft: boolean;
        prerelease: boolean;
        assets: Array<{ name: string; browser_download_url: string; size: number; digest?: string | null }>;
      }>;
      for (const release of releases) {
        if (release.draft || !/^b\d+$/.test(release.tag_name)) continue;
        const candidate: Release = {
          tag: release.tag_name,
          assets: release.assets.map((a) => ({
            name: a.name,
            url: a.browser_download_url,
            size: a.size,
            digest: a.digest ?? null,
          })),
        };
        const assets = selectAssets(candidate, hardware, backend);
        if (assets) return { release: candidate, assets };
      }
      throw new Error(`no recent llama.cpp release has a ${backend} build for ${hardware.platform}-${hardware.arch}`);
    },
    catch: (cause) => new Error(`Could not check llama.cpp releases: ${cause instanceof Error ? cause.message : String(cause)}`),
  });

/** An installed engine, recorded in `<root>/engine.json`. */
export interface InstalledEngine {
  readonly tag: string;
  readonly backend: ConcreteBackend;
  readonly binDir: string;
  readonly installedAt: number;
}

export const serverBinary = (engine: InstalledEngine) =>
  join(engine.binDir, process.platform === "win32" ? "llama-server.exe" : "llama-server");

export const readInstalled = (root: string): InstalledEngine | null => {
  try {
    const engine = JSON.parse(readFileSync(join(root, "engine.json"), "utf8")) as InstalledEngine;
    return existsSync(serverBinary(engine)) ? engine : null;
  } catch {
    return null;
  }
};

/** Streams a download to disk, hashing it on the way. */
const download = async (
  asset: ReleaseAsset,
  path: string,
  signal: AbortSignal,
  onProgress: (done: number) => void,
) => {
  const response = await fetch(asset.url, { signal, headers: { "user-agent": "apollo-desktop" } });
  if (!response.ok || !response.body) throw new Error(`download of ${asset.name} failed: ${response.status}`);
  const hash = createHash("sha256");
  let done = 0;
  const body = Readable.fromWeb(response.body as never);
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    done += chunk.length;
    onProgress(done);
  });
  await pipeline(body, createWriteStream(path), { signal });
  const actual = `sha256:${hash.digest("hex")}`;
  if (asset.digest && asset.digest !== actual) {
    rmSync(path, { force: true });
    throw new Error(`${asset.name} does not match its published checksum`);
  }
};

const filesUnder = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

/**
 * Downloads, verifies and unpacks a build into `<root>/engines/<tag>-<backend>/`,
 * then records it. Older engines are removed once the new one is in place.
 */
export const installEngine = (
  root: string,
  release: Release,
  assets: ReadonlyArray<ReleaseAsset>,
  backend: ConcreteBackend,
  onProgress: (step: string, done: number, total: number) => void,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const name = `${release.tag}-${backend}`;
      const engines = join(root, "engines");
      const target = join(engines, name);
      const staging = join(root, "staging");
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      const total = assets.reduce((sum, a) => sum + a.size, 0);
      let before = 0;

      for (const [index, asset] of assets.entries()) {
        const archive = join(staging, asset.name);
        await download(asset, archive, signal, (done) => onProgress(`Downloading ${asset.name}`, before + done, total));
        before += asset.size;
        onProgress("Unpacking", before, total);
        const into = join(staging, `x${index}`);
        mkdirSync(into);
        // bsdtar (macOS, Windows 10+) and GNU tar both read these archives.
        const output = await Effect.runPromise(run("tar", ["-xf", archive, "-C", into]));
        if (output === null) throw new Error(`could not unpack ${asset.name}`);
        rmSync(archive);
      }

      // Flatten: binaries and their libraries end up side by side (they load from $ORIGIN).
      const bin = join(staging, "bin");
      mkdirSync(bin);
      for (const index of assets.keys()) {
        for (const file of filesUnder(join(staging, `x${index}`))) {
          renameSync(file, join(bin, file.split(/[\\/]/).pop()!));
        }
      }
      const engine: InstalledEngine = { tag: release.tag, backend, binDir: join(target, "bin"), installedAt: Date.now() };
      if (!existsSync(join(bin, process.platform === "win32" ? "llama-server.exe" : "llama-server"))) {
        throw new Error("the archive has no llama-server");
      }
      mkdirSync(engines, { recursive: true });
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target);
      renameSync(bin, engine.binDir);
      rmSync(staging, { recursive: true, force: true });
      writeFileSync(join(root, "engine.json"), JSON.stringify(engine, null, 2));
      for (const old of readdirSync(engines)) {
        if (old !== name) rmSync(join(engines, old), { recursive: true, force: true });
      }
      return engine;
    },
    catch: (cause) => new Error(`Installing llama.cpp failed: ${cause instanceof Error ? cause.message : String(cause)}`),
  });
