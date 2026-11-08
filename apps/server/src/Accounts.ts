import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AccountProvider, ApolloError, type ProviderAccount } from "@apollo/contracts";
import { findExecutable } from "@apollo/providers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "./Config.ts";
import { SessionManager } from "./SessionManager.ts";
import { Store } from "./Store.ts";

/**
 * Other Claude and Codex subscriptions bots can run on (personal next to work). Each
 * account is the CLI's config folder under `<data>/<provider>-accounts/<id>`, pointed to
 * with `CLAUDE_CONFIG_DIR` or `CODEX_HOME`: Claude Code keeps a separate Keychain login per
 * folder and Codex keeps its login in the folder, so each account has its own subscription
 * and connectors (claude.ai connectors, ChatGPT apps). The user's settings, instructions,
 * skills and conversation history are linked from `~/.claude` / `~/.codex`, so they are
 * shared, and a bot switched to another account keeps its conversations.
 */

const SETTINGS_KEY = "providers.accounts";
/** Where accounts were kept when only Claude had them. */
const LEGACY_KEY = "providers.claude.accounts";

interface Status {
  readonly loggedIn: boolean;
  readonly email: string | null;
  readonly orgName: string | null;
  readonly plan: string | null;
}

const NOT_SIGNED_IN: Status = { loggedIn: false, email: null, orgName: null, plan: null };

interface Driver {
  /** The user's own folder for this CLI, whose shared parts are linked in. */
  readonly home: string;
  /** Linked from `home` into each account's folder. */
  readonly shared: ReadonlyArray<string>;
  readonly env: (dir: string) => Record<string, string | undefined>;
  readonly signInArgs: ReadonlyArray<string>;
  readonly signOutArgs: ReadonlyArray<string>;
  readonly status: (exe: string, env: NodeJS.ProcessEnv, dir: string) => Promise<Status>;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

const run = (exe: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  new Promise<{ ok: boolean; stdout: string }>((resolve) =>
    execFile(exe, [...args], { env, timeout: 20_000, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(exe) }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) })),
  );

const DRIVERS: Record<AccountProvider, Driver> = {
  claude: {
    home: join(homedir(), ".claude"),
    shared: ["settings.json", "CLAUDE.md", "skills", "agents", "commands", "plugins", "projects", "hooks", "output-styles"],
    env: (dir) => ({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined }),
    signInArgs: ["auth", "login", "--claudeai"],
    signOutArgs: ["auth", "logout"],
    status: async (exe, env) => {
      const { stdout } = await run(exe, ["auth", "status", "--json"], env);
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
    signInArgs: ["login"],
    signOutArgs: ["logout"],
    status: async (exe, env, dir) => {
      const { ok, stdout } = await run(exe, ["login", "status"], env);
      if (!ok || !/logged in/i.test(stdout)) return NOT_SIGNED_IN;
      // The ChatGPT login's id token names the account and its plan.
      try {
        const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as { tokens?: { id_token?: string } };
        const claims = JSON.parse(Buffer.from(auth.tokens?.id_token?.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
        const openai = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
        return { loggedIn: true, email: str(claims.email), orgName: null, plan: str(openai.chatgpt_plan_type) };
      } catch {
        return { loggedIn: true, email: null, orgName: null, plan: /api key/i.test(stdout) ? "API key" : null };
      }
    },
  },
};

export const accountDir = (dataDir: string, provider: AccountProvider, accountId: string) => join(dataDir, `${provider}-accounts`, accountId);

/** The environment that runs a CLI on an account: its folder, and no inherited credentials. */
export const accountEnvironment = (dataDir: string, provider: AccountProvider, accountId: string) =>
  DRIVERS[provider].env(accountDir(dataDir, provider, accountId));

interface Stored {
  readonly id: string;
  readonly provider: AccountProvider;
  readonly name: string;
}

interface SignIn {
  readonly child: ChildProcessWithoutNullStreams;
  url: string | null;
  error: string | null;
}

const invalid = (message: string) => new ApolloError({ code: "invalid", message });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const store = yield* Store;
  const manager = yield* SessionManager;
  const statuses = new Map<string, { at: number; status: Status }>();
  const signIns = new Map<string, SignIn>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const s of signIns.values()) s.child.kill();
    }),
  );

  const exeFor = (provider: AccountProvider) =>
    provider === "claude" ? (config.claudeExecutable ?? findExecutable(["claude"])) : (config.codexExecutable ?? findExecutable(["codex"]));
  const dirOf = (a: Stored) => accountDir(config.dataDir, a.provider, a.id);
  const envOf = (a: Stored) => {
    const out: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(DRIVERS[a.provider].env(dirOf(a)))) {
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out;
  };

  const read = Effect.gen(function* () {
    const parse = (raw: string | null) => {
      try {
        return raw ? (JSON.parse(raw) as Array<Stored>) : [];
      } catch {
        return [];
      }
    };
    const accounts = parse(yield* store.getSetting(SETTINGS_KEY));
    const legacy = parse(yield* store.getSetting(LEGACY_KEY));
    return [...legacy.map((a) => ({ ...a, provider: "claude" as const })), ...accounts];
  });
  const write = (accounts: ReadonlyArray<Stored>) =>
    Effect.andThen(store.setSetting(SETTINGS_KEY, JSON.stringify(accounts)), store.setSetting(LEGACY_KEY, null));

  /** Creates the account's folder, linking what is shared with the user's own setup. */
  const prepare = (a: Stored) => {
    const dir = dirOf(a);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const driver = DRIVERS[a.provider];
    for (const name of driver.shared) {
      const source = join(driver.home, name);
      const target = join(dir, name);
      if (!existsSync(source)) continue;
      try {
        lstatSync(target);
        continue; // already there (a link, or the account's own)
      } catch {
        // missing
      }
      try {
        symlinkSync(source, target);
      } catch {
        // best effort: the account still works without it
      }
    }
  };

  const status = (a: Stored, refresh = false) =>
    Effect.promise(async () => {
      const hit = statuses.get(a.id);
      if (hit && !refresh && Date.now() - hit.at < 60_000) return hit.status;
      const exe = exeFor(a.provider);
      const status = exe ? await DRIVERS[a.provider].status(exe, envOf(a), dirOf(a)).catch(() => NOT_SIGNED_IN) : NOT_SIGNED_IN;
      statuses.set(a.id, { at: Date.now(), status });
      return status;
    });

  const view = (a: Stored, refresh = false): Effect.Effect<ProviderAccount> =>
    Effect.map(status(a, refresh), (s) => {
      const signIn = signIns.get(a.id);
      return { id: a.id, provider: a.provider, name: a.name, ...s, signIn: signIn ? { url: signIn.url, error: signIn.error } : null };
    });

  const find = (id: string) =>
    Effect.flatMap(read, (accounts) => {
      const account = accounts.find((a) => a.id === id);
      return account ? Effect.succeed(account) : Effect.fail(invalid("that account was removed"));
    });

  const list = Effect.flatMap(read, (accounts) => Effect.forEach(accounts, (a) => view(a), { concurrency: 4 }));

  const add = (provider: AccountProvider, name: string) =>
    Effect.gen(function* () {
      const clean = name.trim();
      if (!clean) return yield* invalid("give the account a name, e.g. Personal or Work");
      const accounts = yield* read;
      if (accounts.some((a) => a.provider === provider && a.name.toLowerCase() === clean.toLowerCase())) {
        return yield* invalid(`there is already an account called ${clean}`);
      }
      const account: Stored = { id: `acct_${randomBytes(6).toString("hex")}`, provider, name: clean.slice(0, 40) };
      prepare(account);
      yield* write([...accounts, account]);
      return yield* view(account);
    });

  const rename = (id: string, name: string) =>
    Effect.gen(function* () {
      const clean = name.trim();
      if (!clean) return yield* invalid("the name is empty");
      yield* find(id);
      const next = (yield* read).map((a) => (a.id === id ? { ...a, name: clean.slice(0, 40) } : a));
      yield* write(next);
      return yield* view(next.find((a) => a.id === id)!);
    });

  const remove = (id: string) =>
    Effect.gen(function* () {
      const account = yield* find(id);
      signIns.get(id)?.child.kill();
      signIns.delete(id);
      // Its bots go back to this machine's login (their sessions reopen there).
      for (const bot of yield* store.listBots) {
        if (account.provider === "claude" && bot.claudeAccountId === id) {
          yield* manager.updateBot({ botId: bot.id, claudeAccountId: null }).pipe(Effect.ignore);
        }
        if (account.provider === "codex" && bot.codexAccountId === id) {
          yield* manager.updateBot({ botId: bot.id, codexAccountId: null }).pipe(Effect.ignore);
        }
      }
      const exe = exeFor(account.provider);
      if (exe) yield* Effect.promise(() => run(exe, DRIVERS[account.provider].signOutArgs, envOf(account)));
      rmSync(dirOf(account), { recursive: true, force: true });
      statuses.delete(id);
      yield* write((yield* read).filter((a) => a.id !== id));
    });

  /**
   * Runs the CLI's sign-in in the account's folder: it opens the browser. Claude's page may
   * show a code to paste back (submitCode); Codex finishes on its own.
   */
  const signIn = (id: string) =>
    Effect.gen(function* () {
      const account = yield* find(id);
      const exe = exeFor(account.provider);
      if (!exe) return yield* invalid(`the ${account.provider} CLI was not found on this machine`);
      signIns.get(id)?.child.kill();
      prepare(account);
      const child = spawn(exe, [...DRIVERS[account.provider].signInArgs], {
        env: envOf(account),
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(exe),
      });
      const entry: SignIn = { child, url: null, error: null };
      signIns.set(id, entry);
      let output = "";
      const onData = (chunk: Buffer) => {
        output = `${output}${chunk.toString()}`.slice(-8000);
        entry.url ??= /(https:\/\/\S+(?:oauth|authorize)\S*)/.exec(output)?.[1] ?? null;
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const timer = setTimeout(() => child.kill(), 15 * 60_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        statuses.delete(id);
        if (signIns.get(id) !== entry) return;
        if (code === 0) signIns.delete(id);
        else entry.error = output.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 300) ?? "sign-in did not finish";
      });
      // Give the CLI a moment to print the page it opened.
      for (let i = 0; i < 30 && !entry.url && child.exitCode === null; i++) yield* Effect.sleep("100 millis");
      return yield* view(account, true);
    });

  const submitCode = (id: string, code: string) =>
    Effect.gen(function* () {
      const entry = signIns.get(id);
      if (!entry || entry.child.exitCode !== null) return yield* invalid("no sign-in is waiting; start it again");
      if (!code.trim()) return yield* invalid("paste the code the sign-in page shows");
      entry.child.stdin.write(`${code.trim()}\n`);
      for (let i = 0; i < 100 && entry.child.exitCode === null; i++) yield* Effect.sleep("100 millis");
      if (entry.error) return yield* invalid(entry.error);
    });

  return { list, add, rename, remove, signIn, submitCode };
});

export class Accounts extends Context.Service<Accounts, Effect.Success<typeof make>>()("apollo/Accounts") {}

export const layer = Layer.effect(Accounts, make);
