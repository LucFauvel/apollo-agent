import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ApolloError, ProviderKind, type ProviderVersion } from "@apollo/contracts";
import { antigravityPaths, findExecutable, installAntigravity } from "@apollo/providers";
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

/** Each agent CLI: how to find it, its npm package (to compare versions) and its self-update command. */
interface Cli {
  readonly name: string;
  readonly exe: () => string | null | undefined;
  readonly npm?: string;
  readonly update?: ReadonlyArray<string>;
}

/**
 * Whether the agent CLIs and llama.cpp have updates, like an app's "update available"
 * badge. CLIs published on npm are compared with their latest release; those with a
 * self-update command update themselves (`claude update`, `opencode upgrade` ...).
 * llama.cpp builds and Antigravity's ACP server come from Apollo's own installers.
 */
const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const localModels = yield* LocalModels;
  const cache = new Map<ProviderKind, { at: number; version: ProviderVersion }>();
  const agentsDir = join(config.dataDir, "agents");

  const CLIS: Partial<Record<ProviderKind, Cli>> = {
    claude: { name: "claude", exe: () => config.claudeExecutable, npm: "@anthropic-ai/claude-code", update: ["update"] },
    codex: { name: "codex", exe: () => config.codexExecutable ?? "codex", npm: "@openai/codex", update: ["update"] },
    cursor: { name: "cursor-agent", exe: () => findExecutable(["cursor-agent", "agent"]), update: ["update"] },
    grok: { name: "grok", exe: () => findExecutable(["grok"]), npm: "@xai-official/grok" },
    opencode: { name: "opencode", exe: () => findExecutable(["opencode"]), npm: "opencode-ai", update: ["upgrade"] },
    muse: { name: "muse", exe: () => findExecutable(["muse"]) },
    pi: { name: "pi", exe: () => findExecutable(["pi"]), npm: "@earendil-works/pi-coding-agent" },
    copilot: { name: "copilot", exe: () => findExecutable(["copilot"]), npm: "@github/copilot" },
  };

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
      if (kind === "antigravity") {
        const paths = antigravityPaths(agentsDir);
        const installed = existsSync(paths.executable) ? paths.version : null;
        return {
          provider: kind,
          installed,
          latest: paths.version,
          updateAvailable: false,
          canUpdate: installed === null,
          note: installed === null ? "Installs on first use" : null,
        };
      }
      const cli = CLIS[kind]!;
      const exe = cli.exe();
      // In development Claude Code comes with Apollo's SDK and updates with it.
      if (kind === "claude" && !exe) {
        return { provider: kind, installed: null, latest: null, updateAvailable: false, canUpdate: false, note: "Bundled with Apollo." };
      }
      if (!exe) {
        // CLIs published on npm: Apollo can install them (npm install -g).
        const installable = cli.npm !== undefined && kind !== "claude" && kind !== "codex" && findExecutable(["npm"]) !== null;
        return { provider: kind, installed: null, latest: null, updateAvailable: false, canUpdate: installable, note: "Not installed" };
      }
      const [installed, latest] = yield* Effect.all(
        [
          Effect.tryPromise(() => run(exe, ["--version"], 15_000)).pipe(Effect.map(versionOf), Effect.orElseSucceed(() => null)),
          cli.npm ? Effect.tryPromise(() => npmLatest(cli.npm!)).pipe(Effect.orElseSucceed(() => null)) : Effect.succeed(null),
        ],
        { concurrency: 2 },
      );
      return {
        provider: kind,
        installed,
        latest,
        updateAvailable: installed !== null && latest !== null && isOlder(installed, latest),
        canUpdate: installed !== null && (cli.update !== undefined || cli.npm !== undefined),
        note: installed === null ? `${cli.name} was not found.` : null,
      };
    });

  const versions = (refresh: boolean) =>
    Effect.forEach(
      ProviderKind.literals,
      (kind) =>
        Effect.gen(function* () {
          const hit = cache.get(kind);
          if (hit && !refresh && Date.now() - hit.at < CHECK_EVERY_MS) return hit.version;
          const version = yield* check(kind);
          cache.set(kind, { at: Date.now(), version });
          return version;
        }),
      { concurrency: 4 },
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
      } else if (kind === "antigravity") {
        yield* installAntigravity(agentsDir).pipe(Effect.mapError((e) => new ApolloError({ code: "internal", message: e.message })));
      } else {
        const cli = CLIS[kind]!;
        const exe = cli.exe();
        const npm = findExecutable(["npm"]);
        if (!exe && kind === "claude") return yield* new ApolloError({ code: "invalid", message: "Claude Code is bundled with Apollo here" });
        // Its own update command when it has one; npm for CLIs published there (install or update).
        const command: readonly [string, ReadonlyArray<string>] | null =
          exe && cli.update ? [exe, cli.update] : cli.npm && npm ? [npm, ["install", "-g", `${cli.npm}@latest`]] : null;
        if (!command) {
          return yield* new ApolloError({ code: "invalid", message: exe ? `${cli.name} cannot update itself; update it the way you installed it` : `${cli.name} is not installed` });
        }
        yield* Effect.tryPromise({
          try: () => run(command[0], command[1], 10 * 60_000),
          catch: (error) => new ApolloError({ code: "internal", message: `${kind} ${exe ? "update" : "install"} failed: ${(error as Error).message}` }),
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
