import { execFile } from "node:child_process";
import { ApolloError, type ProviderKind, type ProviderVersion } from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "./Config.ts";
import { LocalModels } from "./local/LocalModels.ts";

const CHECK_EVERY_MS = 6 * 60 * 60_000;

const run = (command: string, args: ReadonlyArray<string>, timeoutMs: number) =>
  new Promise<string>((resolve, reject) => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(((stderr || stdout || error.message) as string).trim()));
      else resolve(`${stdout}${stderr}`);
    });
  });

const versionOf = (text: string) => /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;

/** `a` is older than `b` (numeric x.y.z). */
export const isOlder = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
};

const npmLatest = async (pkg: string) => {
  const response = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`npm answered ${response.status}`);
  return ((await response.json()) as { version?: string }).version ?? null;
};

const PACKAGES = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" } as const;

/**
 * Whether Claude Code, Codex and llama.cpp have updates, like an app's "update available"
 * badge. Claude Code and Codex are compared with their npm releases and update themselves
 * (`claude update`, `codex update`); llama.cpp builds come from Apollo's own installer.
 */
const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const localModels = yield* LocalModels;
  const cache = new Map<ProviderKind, { at: number; version: ProviderVersion }>();

  const cli = (kind: "claude" | "codex") => (kind === "claude" ? config.claudeExecutable : (config.codexExecutable ?? "codex"));

  const check = (kind: ProviderKind): Effect.Effect<ProviderVersion> =>
    Effect.gen(function* () {
      if (kind === "llamacpp") {
        const state = yield* localModels.checkForUpdate.pipe(Effect.catch(() => localModels.state));
        const installed = state.engine.installed?.tag ?? null;
        const latest = state.engine.latestTag;
        return {
          provider: kind,
          installed,
          latest,
          updateAvailable: installed !== null && latest !== null && latest !== installed,
          canUpdate: installed !== null,
          note: installed === null ? "Not installed (Providers → Local models)." : null,
        };
      }
      const exe = cli(kind);
      // In development Claude Code comes with Apollo's SDK and updates with it.
      if (!exe) {
        return { provider: kind, installed: null, latest: null, updateAvailable: false, canUpdate: false, note: "Bundled with Apollo." };
      }
      const [installed, latest] = yield* Effect.all(
        [
          Effect.tryPromise(() => run(exe, ["--version"], 15_000)).pipe(Effect.map(versionOf), Effect.orElseSucceed(() => null)),
          Effect.tryPromise(() => npmLatest(PACKAGES[kind])).pipe(Effect.orElseSucceed(() => null)),
        ],
        { concurrency: 2 },
      );
      return {
        provider: kind,
        installed,
        latest,
        updateAvailable: installed !== null && latest !== null && isOlder(installed, latest),
        canUpdate: installed !== null,
        note: installed === null ? `${kind === "claude" ? "claude" : "codex"} was not found.` : null,
      };
    });

  const versions = (refresh: boolean) =>
    Effect.forEach(
      ["claude", "codex", "llamacpp"] as const,
      (kind) =>
        Effect.gen(function* () {
          const hit = cache.get(kind);
          if (hit && !refresh && Date.now() - hit.at < CHECK_EVERY_MS) return hit.version;
          const version = yield* check(kind);
          cache.set(kind, { at: Date.now(), version });
          return version;
        }),
      { concurrency: 3 },
    );

  const update = (kind: ProviderKind) =>
    Effect.gen(function* () {
      if (kind === "llamacpp") {
        const state = yield* localModels.state;
        const backend = state.engine.installed?.backend;
        if (!backend) return yield* new ApolloError({ code: "invalid", message: "llama.cpp is not installed" });
        // The install runs in the background (its progress reaches the UI as local model
        // changes); wait for it to finish before checking the version again.
        yield* localModels.installEngine(backend).pipe(Effect.mapError((e) => new ApolloError({ code: "internal", message: e.message })));
        for (let i = 0; i < 600; i++) {
          yield* Effect.sleep("1 second");
          const now = yield* localModels.state;
          if (now.engine.installing === null) {
            if (now.engine.error) return yield* new ApolloError({ code: "internal", message: now.engine.error });
            break;
          }
        }
      } else {
        const exe = cli(kind);
        if (!exe) return yield* new ApolloError({ code: "invalid", message: "Claude Code is bundled with Apollo here" });
        yield* Effect.tryPromise({
          try: () => run(exe, ["update"], 5 * 60_000),
          catch: (error) => new ApolloError({ code: "internal", message: `${kind} update failed: ${(error as Error).message}` }),
        });
      }
      const version = yield* check(kind);
      cache.set(kind, { at: Date.now(), version });
      return version;
    });

  // First check a little after startup, in the background.
  yield* versions(false).pipe(Effect.delay(Duration.seconds(20)), Effect.ignore, Effect.forkScoped);

  return { versions, update };
});

export class ProviderVersions extends Context.Service<ProviderVersions, Effect.Success<typeof make>>()("apollo/ProviderVersions") {}

export const layer = Layer.effect(ProviderVersions, make);
