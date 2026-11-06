import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hardware, QuantOption } from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../Config.ts";
import * as Database from "../Database.ts";
import * as ProviderSettings from "../ProviderSettings.ts";
import * as Store from "../Store.ts";
import { type Release, recommendBackend, selectAssets } from "./Engine.ts";
import { modelShape, parseGgufHeader } from "./Gguf.ts";
import { parseCudaVersion, parseListDevices, parseNvidiaSmi } from "./Hardware.ts";
import { LocalModels, layer as localModelsLayer, loadProgressOf, reapOrphans, toLocalModel } from "./LocalModels.ts";
import { bitsOf, fitOf, groupQuants, memoryBudget, memoryNeeded, pickQuant } from "./Lookup.ts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const linux: Hardware = {
  platform: "linux",
  arch: "x64",
  ramBytes: 32 * GIB,
  gpus: [{ name: "NVIDIA GeForce RTX 3070", vendor: "nvidia", memoryBytes: 8 * GIB, freeBytes: 7 * GIB, unified: false }],
  cudaVersion: "13.4",
};

// ---------------------------------------------------------------------------
// GGUF
// ---------------------------------------------------------------------------

/** Writes a GGUF header with the given metadata (u32, string and u32-array values). */
const gguf = (metadata: Record<string, number | string | Array<number>>) => {
  const parts: Array<Buffer> = [];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    parts.push(b);
  };
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    parts.push(b);
  };
  const str = (s: string) => {
    u64(Buffer.byteLength(s));
    parts.push(Buffer.from(s));
  };
  parts.push(Buffer.from("GGUF"));
  u32(3);
  u64(0);
  u64(Object.keys(metadata).length + 1);
  for (const [key, value] of Object.entries(metadata)) {
    str(key);
    if (typeof value === "string") {
      u32(8);
      str(value);
    } else if (Array.isArray(value)) {
      u32(9);
      u32(4);
      u64(value.length);
      value.forEach(u32);
    } else {
      u32(4);
      u32(value);
    }
  }
  // A long string array, like a tokenizer's vocabulary, comes last.
  str("tokenizer.ggml.tokens");
  u32(9);
  u32(8);
  u64(3);
  ["a", "bb", "ccc"].forEach(str);
  return new Uint8Array(Buffer.concat(parts));
};

describe("GGUF header", () => {
  it("reads metadata, and stops cleanly when the buffer is cut short", () => {
    const bytes = gguf({ "general.architecture": "llama", "llama.block_count": 32 });
    const full = parseGgufHeader(bytes);
    expect(full.complete).toBe(true);
    expect(full.metadata.get("llama.block_count")).toBe(32);
    const partial = parseGgufHeader(bytes.subarray(0, bytes.length - 5));
    expect(partial.complete).toBe(false);
    expect(partial.metadata.get("general.architecture")).toBe("llama");
  });

  it("estimates the KV cache of dense, hybrid and per-layer attention layouts", () => {
    // Qwen3-4B: 36 layers, 8 KV heads of 128: 147 KiB per token at f16, ~78 KB at q8_0.
    const dense = modelShape(
      parseGgufHeader(
        gguf({
          "general.architecture": "qwen3",
          "qwen3.block_count": 36,
          "qwen3.embedding_length": 2560,
          "qwen3.attention.head_count": 32,
          "qwen3.attention.head_count_kv": 8,
          "qwen3.attention.key_length": 128,
          "qwen3.attention.value_length": 128,
          "qwen3.context_length": 262144,
        }),
      ).metadata,
    );
    expect(dense).toEqual({ architecture: "qwen3", contextLength: 262144, kvBytesPerToken: 78336 });
    // The measured cache was 4.79 GiB at 64K tokens.
    expect((dense!.kvBytesPerToken * 65536) / GIB).toBeCloseTo(4.78, 1);

    // Hybrid: full attention every 4th of 40 layers.
    const hybrid = modelShape(
      parseGgufHeader(
        gguf({
          "general.architecture": "qwen35",
          "qwen35.block_count": 40,
          "qwen35.attention.head_count": 16,
          "qwen35.attention.head_count_kv": 2,
          "qwen35.attention.key_length": 256,
          "qwen35.full_attention_interval": 4,
        }),
      ).metadata,
    );
    expect(hybrid?.kvBytesPerToken).toBe(Math.ceil(10 * 2 * 512 * (34 / 32)));

    // Per-layer KV heads: layers with 0 have no cache.
    const perLayer = modelShape(
      parseGgufHeader(
        gguf({
          "general.architecture": "x",
          "x.block_count": 4,
          "x.embedding_length": 1024,
          "x.attention.head_count": 8,
          "x.attention.head_count_kv": [2, 0, 2, 0],
        }),
      ).metadata,
    );
    expect(perLayer?.kvBytesPerToken).toBe(Math.ceil(2 * 2 * 256 * (34 / 32)));
  });
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

describe("model lookup", () => {
  it("groups files into quantizations, summing shards and skipping sidecars", () => {
    const quants = groupQuants([
      { path: "Model-Q4_K_M.gguf", size: 4 * GIB },
      { path: "Model-UD-Q4_K_XL.gguf", size: 4.2 * GIB },
      { path: "Q8_0/Model-Q8_0-00001-of-00002.gguf", size: 5 * GIB },
      { path: "Q8_0/Model-Q8_0-00002-of-00002.gguf", size: 3 * GIB },
      { path: "mmproj-F16.gguf", size: 0.8 * GIB },
      { path: "Model-MTP-Q8_0.gguf", size: 0.3 * GIB },
      { path: "README.md", size: 100 },
    ]);
    expect(quants.map((q) => [q.quant, q.sizeBytes / GIB, q.firstFile])).toEqual([
      ["Q4_K_M", 4, "Model-Q4_K_M.gguf"],
      ["UD-Q4_K_XL", 4.2, "Model-UD-Q4_K_XL.gguf"],
      ["Q8_0", 8, "Q8_0/Model-Q8_0-00001-of-00002.gguf"],
    ]);
    expect([bitsOf("Q4_K_M"), bitsOf("UD-Q6_K_XL"), bitsOf("IQ2_XXS"), bitsOf("BF16")]).toEqual([4.6, 6.6, 2.6, 16]);
  });

  it("sizes quants against GPU and RAM, and picks the best 4-bit+ build that fits", () => {
    const budget = memoryBudget(linux);
    // 7 GiB free of 8, minus the 1 GiB --fit keeps free.
    expect(budget.gpu).toBe(6 * GIB);
    const shape = { architecture: "x", contextLength: 262144, kvBytesPerToken: 20_000 };
    // 20 kB/token at 64K = 1.22 GiB of cache.
    expect(memoryNeeded(4 * GIB, shape) / GIB).toBeCloseTo(4 + 1.22 + 0.6, 1);

    const option = (quant: string, size: number): QuantOption => {
      const memoryBytes = memoryNeeded(size * GIB, shape);
      return { quant, sizeBytes: size * GIB, bits: bitsOf(quant), memoryBytes, fit: fitOf(memoryBytes, budget) };
    };
    const quants = [option("IQ2_XXS", 2), option("Q4_K_M", 4), option("Q5_K_M", 5.5), option("Q8_0", 8), option("F16", 15)];
    expect(quants.map((q) => q.fit)).toEqual(["gpu", "gpu", "ram", "ram", "ram"]);
    expect(pickQuant(quants)?.quant).toBe("Q4_K_M");
    // Nothing on the GPU: the most compact 4-bit+ build that works with RAM.
    expect(pickQuant(quants.slice(2))?.quant).toBe("Q5_K_M");
    // Only sub-4-bit fits: no pick.
    expect(pickQuant([option("IQ2_XXS", 2)])).toBeNull();
  });

  it("treats unified memory as GPU memory", () => {
    const mac: Hardware = {
      platform: "darwin",
      arch: "arm64",
      ramBytes: 32 * GIB,
      gpus: [{ name: "Apple silicon", vendor: "apple", memoryBytes: 24 * GIB, freeBytes: null, unified: true }],
      cudaVersion: null,
    };
    expect(memoryBudget(mac)).toEqual({ gpu: 23 * GIB, ram: 0 });
  });
});

// ---------------------------------------------------------------------------
// Hardware and engine builds
// ---------------------------------------------------------------------------

describe("hardware", () => {
  it("parses llama-server devices, nvidia-smi and the driver's CUDA version", () => {
    expect(parseListDevices("Available devices:\n  CUDA0: NVIDIA GeForce RTX 3070 (7890 MiB, 6953 MiB free)\n", 32 * GIB)).toEqual([
      { name: "NVIDIA GeForce RTX 3070", vendor: "nvidia", memoryBytes: 7890 * MIB, freeBytes: 6953 * MIB, unified: false },
    ]);
    expect(parseListDevices("  Metal0: Apple M3 Max (49152 MiB, 49152 MiB free)", 64 * GIB)[0]).toMatchObject({
      vendor: "apple",
      unified: true,
    });
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 3070, 8192, 7116\n")).toEqual([
      { name: "NVIDIA GeForce RTX 3070", vendor: "nvidia", memoryBytes: 8192 * MIB, freeBytes: 7116 * MIB, unified: false },
    ]);
    expect(parseCudaVersion("| NVIDIA-SMI 615.78.08   KMD Version: 615.78.08   CUDA UMD Version: 13.4 |")).toBe("13.4");
    expect(parseCudaVersion("| NVIDIA-SMI 550.54   Driver Version: 550.54   CUDA Version: 12.4 |")).toBe("12.4");
  });
});

describe("engine builds", () => {
  const tag = "b12119";
  const release: Release = {
    tag,
    assets: [
      `cudart-llama-${tag}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
      `cudart-llama-${tag}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
      "cudart-llama-bin-win-cuda-13.4-x64.zip",
      `llama-${tag}-bin-macos-arm64.tar.gz`,
      `llama-${tag}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
      `llama-${tag}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
      `llama-${tag}-bin-ubuntu-rocm-10.0-x64.tar.gz`,
      `llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`,
      `llama-${tag}-bin-ubuntu-x64.tar.gz`,
      `llama-${tag}-bin-win-cpu-x64.zip`,
      `llama-${tag}-bin-win-cuda-13.4-x64.zip`,
      `llama-${tag}-bin-win-vulkan-x64.zip`,
    ].map((name) => ({ name, url: `https://example/${name}`, size: 1, digest: null })),
  };
  const names = (hardware: Hardware, backend: Parameters<typeof selectAssets>[2]) =>
    selectAssets(release, hardware, backend)?.map((a) => a.name) ?? null;

  it("picks CUDA with its runtime for the newest toolkit the driver supports", () => {
    expect(recommendBackend(linux)).toBe("cuda");
    expect(names(linux, "cuda")).toEqual([
      `llama-${tag}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
      `cudart-llama-${tag}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
    ]);
    expect(names({ ...linux, cudaVersion: "12.4" }, "cuda")).toEqual([
      `llama-${tag}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
      `cudart-llama-${tag}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
    ]);
    expect(names({ ...linux, cudaVersion: "11.8" }, "cuda")).toBeNull();
    expect(names({ ...linux, platform: "win32" }, "cuda")).toEqual([
      `llama-${tag}-bin-win-cuda-13.4-x64.zip`,
      "cudart-llama-bin-win-cuda-13.4-x64.zip",
    ]);
  });

  it("covers Vulkan, ROCm, CPU and macOS builds", () => {
    const amd: Hardware = { ...linux, cudaVersion: null, gpus: [{ ...linux.gpus[0]!, vendor: "amd", name: "AMD" }] };
    expect(recommendBackend(amd)).toBe("vulkan");
    expect(names(amd, "vulkan")).toEqual([`llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`]);
    expect(names(amd, "rocm")).toEqual([`llama-${tag}-bin-ubuntu-rocm-10.0-x64.tar.gz`]);
    expect(names({ ...linux, gpus: [] }, "cpu")).toEqual([`llama-${tag}-bin-ubuntu-x64.tar.gz`]);
    expect(names({ ...linux, platform: "win32" }, "cpu")).toEqual([`llama-${tag}-bin-win-cpu-x64.zip`]);
    const mac: Hardware = { ...linux, platform: "darwin", arch: "arm64", cudaVersion: null, gpus: [] };
    expect(recommendBackend(mac)).toBe("metal");
    expect(names(mac, "metal")).toEqual([`llama-${tag}-bin-macos-arm64.tar.gz`]);
    expect(names(mac, "cuda")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The managed server, against a fake llama-server
// ---------------------------------------------------------------------------

describe("router models", () => {
  it("turns llama-server's staged load progress into one number", () => {
    const stages = ["text_model", "mmproj_model"];
    expect(loadProgressOf({ stages, current: "text_model", value: 0 })).toBe(0);
    expect(loadProgressOf({ stages, current: "text_model", value: 0.5 })).toBeCloseTo(0.45);
    expect(loadProgressOf({ stages, current: "mmproj_model", value: 0.5 })).toBeCloseTo(0.95);
    expect(loadProgressOf({ stages, current: "mmproj_model", value: 1 })).toBe(1);
    expect(loadProgressOf({ stages: ["text_model"], current: "text_model", value: 0.3 })).toBeCloseTo(0.27);
    expect(loadProgressOf({ stage: "mmproj_model" })).toBeNull();
    const loading = toLocalModel({ id: "a:Q4", status: { value: "loading" } }, undefined, 0.4);
    expect(loading).toMatchObject({ status: "loading", loadProgress: 0.4 });
  });

  it("reports whether a loaded model spilled into system RAM", () => {
    const measured = (host: number) => ({
      id: "a/b-GGUF:Q4_K_M",
      status: { value: "loaded" },
      memory: { max: { n_ctx: 65536, devices: [{ kind: "device", model: 2 * GIB }, { kind: "host", model: host }] } },
    });
    expect(toLocalModel(measured(0), undefined)).toMatchObject({ status: "loaded", fit: "gpu", contextSize: 65536, sizeBytes: 2 * GIB });
    expect(toLocalModel(measured(GIB), undefined).fit).toBe("ram");
    expect(toLocalModel(measured(0), { done: 1, total: 2 }).status).toBe("downloading");
  });
});

const fakeServer = fileURLToPath(new URL("./fixtures/llama-server.mjs", import.meta.url));

const managedLayer = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "apollo-local-"));
  const binDir = join(dataDir, "llamacpp", "engines", "b1-cuda", "bin");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(fakeServer, join(binDir, "llama-server"));
  writeFileSync(
    join(dataDir, "llamacpp", "engine.json"),
    JSON.stringify({ tag: "b1", backend: "cuda", binDir, installedAt: 1 }),
  );
  return localModelsLayer.pipe(
    Layer.provideMerge(ProviderSettings.layer),
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(Database.layerMemory),
    Layer.provideMerge(
      Layer.succeed(ServerConfig, {
        dataDir,
        llamaCpp: { baseUrl: "http://127.0.0.1:8080", apiKey: null },
      } as unknown as ServerConfig["Service"]),
    ),
  );
};

const waitFor = <A>(check: Effect.Effect<A | undefined>, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const value = yield* check;
      if (value !== undefined) return value;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`));
  });

describe("orphaned llama-servers", () => {
  it.live("stops processes left running from Apollo's engines folder, and nothing else", () =>
    Effect.gen(function* () {
      const engines = join(mkdtempSync(join(tmpdir(), "apollo-engines-")), "engines");
      mkdirSync(join(engines, "b1-cpu", "bin"), { recursive: true });
      const fake = join(engines, "b1-cpu", "bin", "llama-server");
      // A real binary at that path (a symlink: macOS kills copied system binaries), as `ps`
      // shows llama-server by its own path.
      symlinkSync("/bin/sleep", fake);
      // Orphan-like: started through a shell that exits, so it is not this process's child.
      const orphan = spawn("/bin/sh", ["-c", `"${fake}" 30 & echo $!`], { stdio: ["ignore", "pipe", "ignore"] });
      const pid = Number(yield* Effect.promise(() => new Promise<string>((r) => orphan.stdout!.once("data", (d) => r(String(d))))));
      const bystander = spawn("sleep", ["30"]);
      yield* Effect.sleep("200 millis");

      expect(reapOrphans(engines)).toBeGreaterThanOrEqual(1);
      yield* Effect.sleep("300 millis");
      const alive = (p: number) => {
        try {
          process.kill(p, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive(pid)).toBe(false);
      expect(alive(bystander.pid!)).toBe(true);
      bystander.kill();
    }),
  );
});

describe("managed llama-server", () => {
  it.live(
    "starts the server, downloads a model, and hands sessions a connection",
    () =>
      Effect.gen(function* () {
        const local = yield* LocalModels;
        const initial = yield* local.state;
        expect(initial.engine.installed).toMatchObject({ tag: "b1", backend: "cuda" });
        // Devices come from the installed engine.
        expect(initial.hardware.gpus[0]?.name).toBe("Fake GPU 9000");

        // Without a model, sessions are told what to do.
        const empty = yield* Effect.flip(local.connection);
        expect(empty.message).toContain("No local model is downloaded yet");
        expect((yield* local.state).server.status).toBe("running");

        yield* local.download("unsloth/Tiny-GGUF", "Q4_K_M");
        const model = yield* waitFor(
          Effect.map(local.state, (s) => s.models.find((m) => m.id === "unsloth/Tiny-GGUF:Q4_K_M" && m.status === "unloaded")),
          "the download to finish",
        );
        expect(model).toMatchObject({ fit: "gpu", contextSize: 65536, download: null });

        const connection = yield* local.connection;
        expect(connection.defaultModel).toBe("unsloth/Tiny-GGUF:Q4_K_M");
        expect(connection.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        const response = yield* Effect.promise(() =>
          fetch(`${connection.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${connection.apiKey}` } }),
        );
        expect(response.status).toBe(200);

        yield* local.setDefault("unsloth/Tiny-GGUF:Q4_K_M");
        yield* local.deleteModel("unsloth/Tiny-GGUF:Q4_K_M");
        const after = yield* local.state;
        expect(after.models).toEqual([]);
        expect(after.defaultModel).toBeNull();

        yield* local.stopServer;
        expect((yield* local.state).server.status).toBe("stopped");
        expect((yield* local.logs).some((line) => line.includes("fake llama-server listening"))).toBe(true);
      }).pipe(Effect.provide(managedLayer())),
    30_000,
  );

  it.live("resumes a download cut short when the server starts again", () =>
    Effect.gen(function* () {
      const local = yield* LocalModels;
      const store = yield* Store.Store;
      const id = "unsloth/Slow-GGUF:Q4_K_M";
      yield* local.download("unsloth/Slow-GGUF", "Q4_K_M");
      yield* waitFor(
        Effect.map(local.state, (s) => s.models.find((m) => m.id === id && m.download?.done === 300)),
        "download progress",
      );
      expect(yield* store.getSetting("llamacpp.pendingDownloads")).toBe(JSON.stringify([id]));
      // Sessions on that model, or on the default with nothing else downloaded, wait for it.
      expect(yield* local.downloadBlocking(id)).toBe(id);
      expect(yield* local.downloadBlocking(null)).toBe(id);
      expect(yield* local.downloadBlocking("other:Q8_0")).toBeNull();

      // Apollo quits mid-download, then starts again.
      yield* local.stopServer;
      yield* local.startServer;
      const resumed = yield* waitFor(
        Effect.map(local.state, (s) => s.models.find((m) => m.id === id && m.status === "downloading")),
        "the download to resume",
      );
      expect(resumed.download).not.toBeNull();
      expect((yield* local.logs).some((line) => line.includes(`Resuming the download of ${id}`))).toBe(true);

      // Cancelling forgets it for good.
      yield* local.cancelDownload(id);
      expect(yield* store.getSetting("llamacpp.pendingDownloads")).toBeNull();
      yield* local.stopServer;
    }).pipe(Effect.provide(managedLayer())),
  );

  it.live("resumes a download llama.cpp reports as incomplete", () =>
    Effect.gen(function* () {
      const id = "unsloth/Partial-GGUF:Q4_K_M";
      process.env.FAKE_LLAMA_INCOMPLETE = id;
      const local = yield* LocalModels;
      yield* local.startServer;
      const done = yield* waitFor(
        Effect.map(local.state, (s) => s.models.find((m) => m.id === id && m.status === "unloaded")),
        "the incomplete download to resume and finish",
      );
      expect(done.download).toBeNull();
      expect((yield* local.logs).some((line) => line.includes(`Resuming the download of ${id}`))).toBe(true);
      yield* local.stopServer;
    }).pipe(
      Effect.provide(managedLayer()),
      Effect.ensuring(Effect.sync(() => delete process.env.FAKE_LLAMA_INCOMPLETE)),
    ),
  );

  it.live("reviews unclear tool calls with the reviewer model, and asks when there is none", () =>
    Effect.gen(function* () {
      const local = yield* LocalModels;
      const call = (tool: string) => ({ tool, input: {}, cwd: "/tmp/w", task: "check my Slack" });
      // No reviewer chosen: ask.
      expect(yield* local.review(call("mcp__claude_ai_Slack__slack_search_public"))).toBe("ask");

      yield* local.download("unsloth/Tiny-GGUF", "Q4_K_M");
      const id = "unsloth/Tiny-GGUF:Q4_K_M";
      yield* waitFor(Effect.map(local.state, (s) => s.models.find((m) => m.id === id && m.status === "unloaded")), "the download");
      yield* local.setReviewer(id);
      expect((yield* local.state).reviewerModel).toBe(id);
      expect(yield* local.review(call("mcp__claude_ai_Slack__slack_search_public"))).toBe("allow");
      expect(yield* local.review(call("mcp__claude_ai_Slack__slack_send_message"))).toBe("ask");

      // Removing the model clears the choice.
      yield* local.deleteModel(id);
      expect((yield* local.state).reviewerModel).toBeNull();
      yield* local.stopServer;
    }).pipe(Effect.provide(managedLayer())),
  );

  it.live("explains a refused download", () =>
    Effect.gen(function* () {
      const local = yield* LocalModels;
      yield* local.startServer;
      const error = yield* Effect.flip(local.download("not-a-repo", ""));
      expect(error.message).toBeTruthy();
      yield* local.stopServer;
    }).pipe(Effect.provide(managedLayer())),
  );
});
