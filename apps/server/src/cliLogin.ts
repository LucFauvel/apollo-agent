import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AccountProvider } from "@apollo/contracts";
import { findExecutable } from "@apollo/providers";

/** Claude Code's and Codex's logins: their status, and the sign-in each CLI runs. */

export interface LoginStatus {
  readonly loggedIn: boolean;
  readonly email: string | null;
  readonly orgName: string | null;
  readonly plan: string | null;
}

export const NOT_SIGNED_IN: LoginStatus = { loggedIn: false, email: null, orgName: null, plan: null };

export interface Driver {
  /** The user's own folder for this CLI. */
  readonly home: string;
  /** Linked from `home` into each extra account's folder. */
  readonly shared: ReadonlyArray<string>;
  /** Points the CLI at another config folder, without inherited credentials. */
  readonly env: (dir: string) => Record<string, string | undefined>;
  /** Credentials that would win over the login, removed when checking or signing in. */
  readonly credentialVars: ReadonlyArray<string>;
  readonly signInArgs: ReadonlyArray<string>;
  /** A sign-in finished in another device's browser. */
  readonly deviceSignInArgs: ReadonlyArray<string>;
  readonly signOutArgs: ReadonlyArray<string>;
  readonly status: (exe: string, env: NodeJS.ProcessEnv, dir: string) => Promise<LoginStatus>;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

const isScript = (exe: string) => process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);

export const runCli = (exe: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) =>
    execFile(exe, [...args], { env, timeout: 20_000, shell: isScript(exe) }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );

export const DRIVERS: Record<AccountProvider, Driver> = {
  claude: {
    home: join(homedir(), ".claude"),
    shared: ["settings.json", "CLAUDE.md", "skills", "agents", "commands", "plugins", "projects", "hooks", "output-styles"],
    env: (dir) => ({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined }),
    credentialVars: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    signInArgs: ["auth", "login", "--claudeai"],
    deviceSignInArgs: ["auth", "login", "--claudeai"],
    signOutArgs: ["auth", "logout"],
    status: async (exe, env) => {
      const { stdout } = await runCli(exe, ["auth", "status", "--json"], env);
      try {
        const d = JSON.parse(stdout) as Record<string, unknown>;
        return { loggedIn: d.loggedIn === true, email: str(d.email), orgName: str(d.orgName), plan: str(d.subscriptionType) };
      } catch {
        return NOT_SIGNED_IN;
      }
    },
  },
  codex: {
    home: join(homedir(), ".codex"),
    shared: ["config.toml", "AGENTS.md", "skills", "prompts", "rules", "sessions", "archived_sessions"],
    env: (dir) => ({ CODEX_HOME: dir, OPENAI_API_KEY: undefined }),
    credentialVars: ["OPENAI_API_KEY"],
    signInArgs: ["login"],
    deviceSignInArgs: ["login", "--device-auth"],
    signOutArgs: ["logout"],
    status: async (exe, env, dir) => {
      // Codex prints its status on stderr; signed in exits 0, signed out exits 1.
      const { ok, stdout, stderr } = await runCli(exe, ["login", "status"], env);
      const said = `${stdout}\n${stderr}`;
      if (!ok || /not logged in/i.test(said)) return NOT_SIGNED_IN;
      // The ChatGPT login's id token names the account and its plan.
      try {
        const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as { tokens?: { id_token?: string } };
        const claims = JSON.parse(Buffer.from(auth.tokens?.id_token?.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
        const openai = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
        return { loggedIn: true, email: str(claims.email), orgName: null, plan: str(openai.chatgpt_plan_type) };
      } catch {
        return { loggedIn: true, email: null, orgName: null, plan: /api key/i.test(said) ? "API key" : null };
      }
    },
  },
};

/** `base` with `changes` applied (`undefined` removes a variable). */
export const withEnv = (base: NodeJS.ProcessEnv, changes: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
};

/**
 * Where the official installers put the CLIs (`~/.local/bin`, and Codex's own folder on
 * Windows). A server started before an install, or from a desktop launcher, may not have
 * them on its PATH.
 */
export const installDirs = (home: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform) => [
  join(home, ".local", "bin"),
  ...(platform === "win32" && env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin")] : []),
];

/** The CLI on PATH or where its installer puts it. */
export const findCli = (provider: AccountProvider, home = homedir(), env: NodeJS.ProcessEnv = process.env) =>
  findExecutable([provider], [env.PATH ?? "", ...installDirs(home, env)].filter(Boolean).join(delimiter));

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** The page a sign-in printed: its OAuth page, else the first https link. */
export const signInUrl = (output: string) => {
  const text = output.replace(ANSI, "");
  return /(https:\/\/\S+(?:oauth|authorize)\S*)/.exec(text)?.[1] ?? /(https:\/\/[^\s"'<>]+)/.exec(text)?.[1] ?? null;
};

/** The one-time code a device sign-in asks for, like `ABCD-12345`. */
export const deviceCode = (output: string) => /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/.exec(output.replace(ANSI, ""))?.[1] ?? null;

export interface SignInProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly device: boolean;
  url: string | null;
  userCode: string | null;
  error: string | null;
}

/**
 * Starts a CLI's sign-in. `onExit` runs when it ends: `error` is set when it failed.
 * Stops on its own after 15 minutes.
 */
export const startSignIn = (
  exe: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  options: { readonly device: boolean; readonly onOutput?: () => void; readonly onExit: (entry: SignInProcess) => void },
): SignInProcess => {
  const child = spawn(exe, [...args], { env, stdio: ["pipe", "pipe", "pipe"], shell: isScript(exe) });
  const entry: SignInProcess = { child, device: options.device, url: null, userCode: null, error: null };
  let output = "";
  const onData = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-8000);
    const before = `${entry.url} ${entry.userCode}`;
    entry.url ??= signInUrl(output);
    if (options.device) entry.userCode ??= deviceCode(output);
    if (`${entry.url} ${entry.userCode}` !== before) options.onOutput?.();
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (error) => {
    entry.error = error.message;
  });
  const timer = setTimeout(() => child.kill(), 15 * 60_000);
  child.on("exit", (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      entry.error ??= output.replace(ANSI, "").trim().split("\n").filter(Boolean).at(-1)?.slice(0, 300) ?? "sign-in did not finish";
    }
    options.onExit(entry);
  });
  return entry;
};
