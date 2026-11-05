import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { arch, platform, totalmem } from "node:os";
import { join } from "node:path";
import type { Gpu, Hardware } from "@apollo/contracts";
import * as Effect from "effect/Effect";

const MIB = 1024 * 1024;

/** Runs a command and returns its stdout, or null if it is missing or fails. */
export const run = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  Effect.callback<string | null>((resume) => {
    const child = execFile(command, [...args], { timeout: 15_000, env: env ?? process.env, windowsHide: true }, (error, stdout, stderr) =>
      resume(Effect.succeed(error ? null : `${stdout}${stderr}`)),
    );
    return Effect.sync(() => child.kill());
  });

/** `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits` */
export const parseNvidiaSmi = (output: string): Array<Gpu> =>
  output
    .split("\n")
    .map((line) => line.split(",").map((part) => part.trim()))
    .filter((parts) => parts.length === 3 && parts[0] && Number.isFinite(Number(parts[1])))
    .map(([name, total, free]) => ({
      name: name!,
      vendor: "nvidia" as const,
      memoryBytes: Number(total) * MIB,
      freeBytes: Number(free) * MIB,
      unified: false,
    }));

/** The CUDA version in `nvidia-smi`'s banner ("CUDA Version: 12.4", or "CUDA UMD Version: 13.4"). */
export const parseCudaVersion = (banner: string): string | null =>
  /CUDA (?:UMD )?Version:\s*(\d+\.\d+)/.exec(banner)?.[1] ?? null;

const vendorOf = (name: string): Gpu["vendor"] => {
  const lower = name.toLowerCase();
  if (/nvidia|geforce|rtx|quadro|tesla/.test(lower)) return "nvidia";
  if (/amd|radeon|instinct/.test(lower)) return "amd";
  if (/intel|arc|iris|uhd/.test(lower)) return "intel";
  if (/apple|metal|\bm\d/.test(lower)) return "apple";
  return "other";
};

/**
 * `llama-server --list-devices`, the most accurate source once the engine is
 * installed:  `  CUDA0: NVIDIA GeForce RTX 3070 (7890 MiB, 6953 MiB free)`.
 */
export const parseListDevices = (output: string, ramBytes: number): Array<Gpu> =>
  [...output.matchAll(/^\s*([A-Za-z]+)\d+: (.+?) \((\d+) MiB, (\d+) MiB free\)\s*$/gm)].map(([, backend, name, total, free]) => {
    const vendor = backend === "Metal" || backend === "MTL" ? "apple" : vendorOf(name!);
    const memoryBytes = Number(total) * MIB;
    return {
      name: name!,
      vendor,
      memoryBytes,
      freeBytes: Number(free) * MIB,
      // A GPU reporting about as much memory as the system has shares it.
      unified: vendor === "apple" || memoryBytes >= ramBytes * 0.5,
    };
  });

/** AMD and Intel GPUs on Linux, from sysfs. */
const linuxDrmGpus = (ramBytes: number): Array<Gpu> => {
  const gpus: Array<Gpu> = [];
  let cards: Array<string> = [];
  try {
    cards = readdirSync("/sys/class/drm").filter((name) => /^card\d+$/.test(name));
  } catch {
    return gpus;
  }
  for (const card of cards) {
    const device = join("/sys/class/drm", card, "device");
    const read = (file: string) => {
      try {
        return readFileSync(join(device, file), "utf8").trim();
      } catch {
        return null;
      }
    };
    const vendorId = read("vendor");
    const vram = Number(read("mem_info_vram_total") ?? 0);
    if (vendorId === "0x1002") {
      // Small VRAM carve-outs are APUs that really use system RAM.
      const unified = vram < 2 * 1024 * MIB;
      gpus.push({ name: "AMD GPU", vendor: "amd", memoryBytes: unified ? ramBytes / 2 : vram, freeBytes: null, unified });
    } else if (vendorId === "0x8086") {
      gpus.push({
        name: "Intel GPU",
        vendor: "intel",
        memoryBytes: vram > 0 ? vram : ramBytes / 2,
        freeBytes: null,
        unified: vram === 0,
      });
    }
  }
  return gpus;
};

const windowsGpuNames = run("powershell.exe", [
  "-NoProfile",
  "-Command",
  "(Get-CimInstance Win32_VideoController).Name",
]).pipe(Effect.map((output) => (output ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)));

/**
 * What Apollo knows about this machine's memory and GPUs. With an installed
 * engine, `llama-server --list-devices` gives exact figures; before that, vendor
 * tools and sysfs.
 */
export const detectHardware = (engineBinary: string | null) =>
  Effect.gen(function* () {
    const ramBytes = totalmem();
    const os = platform();
    const banner = yield* run("nvidia-smi", []);
    const cudaVersion = banner ? parseCudaVersion(banner) : null;

    let gpus: Array<Gpu> = [];
    if (engineBinary) {
      const listed = yield* run(engineBinary, ["--list-devices"]);
      if (listed) gpus = parseListDevices(listed, ramBytes);
    }
    if (gpus.length === 0) {
      const nvidia = banner
        ? yield* run("nvidia-smi", ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"])
        : null;
      gpus = nvidia ? parseNvidiaSmi(nvidia) : [];
      if (os === "darwin" && arch() === "arm64") {
        // Metal can use about three quarters of unified memory.
        gpus = [{ name: "Apple silicon", vendor: "apple", memoryBytes: ramBytes * 0.75, freeBytes: null, unified: true }];
      } else if (os === "linux" && gpus.length === 0) {
        gpus = linuxDrmGpus(ramBytes);
      } else if (os === "win32" && gpus.length === 0) {
        gpus = (yield* windowsGpuNames).map((name) => ({
          name,
          vendor: vendorOf(name),
          memoryBytes: 0,
          freeBytes: null,
          unified: false,
        }));
      }
    }
    return { platform: os, arch: arch(), ramBytes, gpus, cudaVersion } satisfies Hardware;
  });
