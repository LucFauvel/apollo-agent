import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type AccountProvider, type AgentCliState, ApolloError } from "@apollo/contracts";
import { findExecutable } from "@apollo/providers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { DRIVERS, findCli, type LoginStatus, type SignInProcess, startSignIn, withEnv } from "./cliLogin.ts";
import { ServerConfig } from "./Config.ts";

/**
 * Claude Code and Codex on this computer: Apollo installs them with their official
 * installers (into `~/.local/bin`, where `claude update` and Codex's own updates keep
 * working), and signs this computer's login in, from the desktop or a phone.
 */

const PROVIDERS: ReadonlyArray<AccountProvider> = ["claude", "codex"];

const NAMES: Record<AccountProvider, string> = { claude: "Claude Code", codex: "Codex" };

/** Official installers: a shell script on macOS and Linux, PowerShell on Windows. */
const INSTALLERS: Record<AccountProvider, { readonly unix: string; readonly windows: string; readonly shell: string }> = {
  claude: { unix: "https://claude.ai/install.sh", windows: "https://claude.ai/install.ps1", shell: "bash" },
  codex: { unix: "https://chatgpt.com/codex/install.sh", windows: "https://chatgpt.com/codex/install.ps1", shell: "sh" },
};

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const LOGIN_FRESH_MS = 60_000;

export interface AgentClisOptions {
  /** Set for every CLI and installer Apollo runs here (tests point HOME and PATH at a temp folder). */
  readonly env?: Record<string, string | undefined>;
  readonly fetchScript?: (url: string) => Promise<string>;
  readonly platform?: NodeJS.Platform;
}

const fetchScript = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.text();
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** The installer's last meaningful line, as its current step. */
const lastLine = (text: string) =>
  text
    .replace(ANSI, "")
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[#=\-_.*\s]+$/.test(l))
    .at(-1)
    ?.slice(0, 200) ?? null;

interface Slot {
  install: { step: string; startedAt: number; child: ChildProcess | null } | null;
  installError: string | null;
  login: { at: number; status: LoginStatus } | null;
  signIn: SignInProcess | null;
}

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

export const make = (options: AgentClisOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const env = withEnv(process.env, options.env ?? {});
    const home = env.HOME ?? homedir();
    const platform = options.platform ?? process.platform;
    const getScript = options.fetchScript ?? fetchScript;
    const bundled = config.claudeBundled ?? true;
    const changes = yield* PubSub.unbounded<ReadonlyArray<AgentCliState>>();
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    const slots: Record<AccountProvider, Slot> = {
      claude: { install: null, installError: null, login: null, signIn: null },
      codex: { install: null, installError: null, login: null, signIn: null },
    };

    const kill = (child: ChildProcess | null | undefined) => {
      if (!child || child.exitCode !== null || child.pid === undefined) return;
      try {
        // Installers run in their own process group: stop what they started too.
        if (platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill();
      } catch {
        child.kill();
      }
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const slot of Object.values(slots)) {
          kill(slot.install?.child);
          slot.signIn?.child.kill();
        }
      }),
    );

    /** The CLI Apollo uses for this provider's login and updates. */
    const executable = (provider: AccountProvider): string | null =>
      (provider === "claude" ? config.claudeExecutable : config.codexExecutable) ?? findCli(provider, home, env);

    /**
     * What sessions run: the CLI, except in development, where Claude Code comes with the
     * Agent SDK (`undefined` lets the SDK use its own).
     */
    const sessionExecutable = (provider: AccountProvider): string | undefined => {
      if (provider === "claude") return config.claudeExecutable ?? (bundled ? undefined : (findCli("claude", home, env) ?? undefined));
      return config.codexExecutable ?? findCli("codex", home, env) ?? undefined;
    };

    const view = (provider: AccountProvider): AgentCliState => {
      const slot = slots[provider];
      const signIn = slot.signIn;
      return {
        provider,
        executable: executable(provider),
        bundled: provider === "claude" && bundled,
        install: slot.install ? { step: slot.install.step, startedAt: slot.install.startedAt } : null,
        installError: slot.installError,
        login: slot.login?.status ?? null,
        signIn: signIn
          ? { url: signIn.url, userCode: signIn.userCode, needsCode: provider === "claude", error: signIn.error }
          : null,
      };
    };

    const snapshot = () => PROVIDERS.map(view);

    let pending: ReturnType<typeof setTimeout> | null = null;
    /** Publishes the state; `soon` folds bursts (installer output) into one update. */
    const notify = (soon = false) => {
      if (soon) {
        pending ??= setTimeout(() => {
          pending = null;
          runFork(PubSub.publish(changes, snapshot()));
        }, 250);
        return;
      }
      runFork(PubSub.publish(changes, snapshot()));
    };

    const loginEnv = (provider: AccountProvider) =>
      withEnv(env, Object.fromEntries(DRIVERS[provider].credentialVars.map((k) => [k, undefined])));

    const refreshLogin = async (provider: AccountProvider, force = true) => {
      const slot = slots[provider];
      if (!force && slot.login && Date.now() - slot.login.at < LOGIN_FRESH_MS) return;
      const exe = executable(provider);
      const dir = provider === "codex" ? (env.CODEX_HOME ?? join(home, ".codex")) : (env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"));
      const status = exe ? await DRIVERS[provider].status(exe, loginEnv(provider), dir).catch(() => null) : null;
      const before = JSON.stringify(slot.login?.status ?? null);
      slot.login = status ? { at: Date.now(), status } : null;
      if (JSON.stringify(status) !== before) notify();
    };

    const runInstaller = async (provider: AccountProvider) => {
      const slot = slots[provider];
      const installer = INSTALLERS[provider];
      const windows = platform === "win32";
      const fail = (message: string) => {
        slot.install = null;
        slot.installError = message;
        notify();
      };
      let script: string;
      try {
        script = await getScript(windows ? installer.windows : installer.unix);
      } catch (error) {
        return fail(`Could not download the installer: ${(error as Error).message}`);
      }
      if (!script.trim() || /^\s*</.test(script)) return fail("The installer download was not a script. Try again later.");
      if (slot.install === null) return;
      const command = windows ? "powershell.exe" : findExecutable([installer.shell], env.PATH ?? "");
      if (!command) return fail(`${installer.shell} was not found on this computer.`);
      const dir = mkdtempSync(join(tmpdir(), `apollo-${provider}-install-`));
      const file = join(dir, windows ? "install.ps1" : "install.sh");
      writeFileSync(file, script, { mode: 0o600 });
      const args = windows ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file] : [file];
      const child = spawn(command, args, {
        cwd: home,
        env: withEnv(env, { CODEX_NON_INTERACTIVE: "1" }),
        stdio: ["ignore", "pipe", "pipe"],
        // Its own session: no terminal for the installers to prompt on.
        detached: !windows,
        windowsHide: true,
      });
      slot.install = { step: `Running ${NAMES[provider]}'s installer`, startedAt: slot.install.startedAt, child };
      notify();
      let output = "";
      const onData = (chunk: Buffer) => {
        output = `${output}${chunk.toString()}`.slice(-16_000);
        const step = lastLine(output);
        if (step && slot.install && step !== slot.install.step) {
          slot.install.step = step;
          notify(true);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const timer = setTimeout(() => kill(child), INSTALL_TIMEOUT_MS);
      const code = await new Promise<number | null>((resolve) => {
        child.on("error", (error) => {
          output += `\n${error.message}`;
          resolve(-1);
        });
        child.on("close", (exit) => resolve(exit));
      });
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      if (slot.install?.child !== child) return;
      if (code !== 0) {
        return fail(lastLine(output) ?? (code === null ? "The installer was stopped." : `The installer stopped (exit code ${code}).`));
      }
      if (!executable(provider)) {
        return fail(`The installer finished, but ${provider} is not in ${join(home, ".local", "bin")}.`);
      }
      slot.install = null;
      slot.installError = null;
      notify();
      await refreshLogin(provider);
    };

    const install = (provider: AccountProvider) =>
      Effect.gen(function* () {
        const slot = slots[provider];
        if (slot.install) return view(provider);
        const exe = executable(provider);
        if (exe) return yield* invalid(`${NAMES[provider]} is already installed (${exe}).`);
        slot.install = { step: "Downloading the installer", startedAt: Date.now(), child: null };
        slot.installError = null;
        notify();
        void runInstaller(provider).catch((error: unknown) => {
          slot.install = null;
          slot.installError = (error as Error).message;
          notify();
        });
        return view(provider);
      });

    const signIn = (provider: AccountProvider, device: boolean) =>
      Effect.gen(function* () {
        const exe = executable(provider);
        if (!exe) return yield* invalid(`Install ${NAMES[provider]} first.`);
        const slot = slots[provider];
        slot.signIn?.child.kill();
        const driver = DRIVERS[provider];
        const entry = startSignIn(exe, device ? driver.deviceSignInArgs : driver.signInArgs, loginEnv(provider), {
          device,
          onOutput: () => notify(),
          onExit: (done) => {
            if (slots[provider].signIn !== done) return;
            if (done.error === null) slots[provider].signIn = null;
            notify();
            void refreshLogin(provider);
          },
        });
        slot.signIn = entry;
        notify();
        // Give the CLI a moment to print the page (and code) to open.
        for (let i = 0; i < 30 && entry.child.exitCode === null && (!entry.url || (device && provider === "codex" && !entry.userCode)); i++) {
          yield* Effect.sleep("100 millis");
        }
        return view(provider);
      });

    const submitCode = (provider: AccountProvider, code: string) =>
      Effect.gen(function* () {
        const entry = slots[provider].signIn;
        if (!entry || entry.child.exitCode !== null) return yield* invalid("No sign-in is waiting; start it again.");
        if (!code.trim()) return yield* invalid("Paste the code the sign-in page shows.");
        entry.child.stdin.write(`${code.trim()}\n`);
        for (let i = 0; i < 100 && entry.child.exitCode === null; i++) yield* Effect.sleep("100 millis");
        if (entry.error) return yield* invalid(entry.error);
        yield* Effect.promise(() => refreshLogin(provider));
        return view(provider);
      });

    const cancelSignIn = (provider: AccountProvider) =>
      Effect.sync(() => {
        const entry = slots[provider].signIn;
        slots[provider].signIn = null;
        entry?.child.kill();
        notify();
        return view(provider);
      });

    /** Waits for an install to end; fails with its error. */
    const awaitInstall = (provider: AccountProvider) =>
      Effect.gen(function* () {
        while (slots[provider].install) yield* Effect.sleep("500 millis");
        const error = slots[provider].installError;
        if (error) return yield* new ApolloError({ code: "internal", message: error });
      });

    return {
      executable,
      sessionExecutable,
      state: Effect.sync(snapshot),
      install,
      awaitInstall,
      signIn,
      submitCode,
      cancelSignIn,
      refreshLogin: (provider: AccountProvider) => Effect.promise(() => refreshLogin(provider)),
      /** `agentClis.watch`: both CLIs, then the whole list on each change. */
      watch: Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          // Logins can change outside Apollo (a terminal): check again when someone looks.
          for (const provider of PROVIDERS) void refreshLogin(provider, false);
          return Stream.concat(Stream.succeed(snapshot()), Stream.fromSubscription(subscription));
        }),
      ) as Stream.Stream<ReadonlyArray<AgentCliState>>,
    };
  });

export class AgentClis extends Context.Service<AgentClis, Effect.Success<ReturnType<typeof make>>>()("apollo/AgentClis") {}

export const layer = Layer.effect(AgentClis, make());

export const layerWith = (options: AgentClisOptions) => Layer.effect(AgentClis, make(options));
