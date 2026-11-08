import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RuntimeMode } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import { type AcpAgent, type AcpLaunch, makeAcpProvider } from "./AcpProvider.ts";
import { findExecutable } from "./AgentSupport.ts";
import { type Provider, ProviderError } from "./Provider.ts";

/**
 * The agents Apollo drives over ACP, with each one's launch command and quirks (modelled
 * on how T3 Code runs them).
 */

const missing = (kind: AcpAgent["kind"], message: string) => Effect.fail(new ProviderError({ provider: kind, message }));

const onPath = (kind: AcpAgent["kind"], names: ReadonlyArray<string>, hint: string, override?: string) =>
  Effect.suspend(() => {
    const found = findExecutable(override ? [override, ...names] : names);
    return found ? Effect.succeed(found) : missing(kind, hint);
  });

// --- Cursor ---------------------------------------------------------------------

const CURSOR_HINT = "Install Cursor's CLI (curl https://cursor.com/install -fsS | bash), then run `cursor-agent login`.";

export const cursorAgent = (executable?: string): AcpAgent => ({
  kind: "cursor",
  name: "Cursor",
  installHint: CURSOR_HINT,
  launch: () => Effect.map(onPath("cursor", ["cursor-agent", "agent"], CURSOR_HINT, executable), (command) => ({ command, args: ["acp"] })),
  authMethod: (methods) => methods.find((m) => /login|cursor/i.test(m.id))?.id ?? methods[0]?.id ?? null,
});

// --- Grok -----------------------------------------------------------------------

const GROK_HINT = "Install the Grok CLI (npm install -g @xai-official/grok), then run `grok login`.";

const grokArgs = (mode: RuntimeMode, readOnly: boolean) => {
  if (readOnly) return ["--permission-mode", "default", "agent", "stdio"];
  switch (mode) {
    case "full-access":
      return ["agent", "--always-approve", "stdio"];
    case "auto":
      return ["--permission-mode", "auto", "agent", "stdio"];
    default:
      return ["--permission-mode", "default", "agent", "stdio"];
  }
};

export const grokAgent = (executable?: string): AcpAgent => ({
  kind: "grok",
  name: "Grok",
  installHint: GROK_HINT,
  launch: ({ runtimeMode, readOnly, probe }) =>
    Effect.map(onPath("grok", ["grok"], GROK_HINT, executable), (command) => ({
      command,
      args: probe ? ["agent", "stdio"] : grokArgs(runtimeMode, readOnly),
    })),
  authMethod: (methods) =>
    (process.env.XAI_API_KEY ? methods.find((m) => m.id === "xai.api_key")?.id : undefined) ??
    methods.find((m) => m.id === "cached_token")?.id ??
    methods[0]?.id ??
    null,
});

// --- OpenCode -------------------------------------------------------------------

const OPENCODE_HINT = "Install OpenCode (curl -fsSL https://opencode.ai/install | bash), then run `opencode auth login`.";

/** OpenCode's permission rules for a runtime mode (`allow`, `ask` or `deny` per tool). */
export const opencodePermissions = (mode: RuntimeMode, readOnly: boolean) => {
  if (readOnly) return { edit: "deny", bash: "deny", webfetch: "allow" };
  switch (mode) {
    case "full-access":
      return { edit: "allow", bash: "allow", webfetch: "allow" };
    case "auto":
      return { edit: "allow", bash: "ask", webfetch: "allow" };
    default:
      return { edit: "ask", bash: "ask", webfetch: "ask" };
  }
};

export const opencodeAgent = (executable?: string): AcpAgent => ({
  kind: "opencode",
  name: "OpenCode",
  installHint: OPENCODE_HINT,
  // OpenCode 2 runs ACP sessions in its background service, which ignores the permission
  // rules below (they apply to OpenCode 1): read-only sessions use its read-only plan agent.
  modeFor: (_mode, readOnly, available) => (readOnly && available.includes("plan") ? "plan" : null),
  launch: ({ runtimeMode, readOnly }) =>
    Effect.map(onPath("opencode", ["opencode"], OPENCODE_HINT, executable), (command) => ({
      command,
      args: ["acp"],
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: opencodePermissions(runtimeMode, readOnly) }) },
    })),
});

// --- GitHub Copilot ---------------------------------------------------------------

const COPILOT_HINT = "Install the GitHub Copilot CLI (npm install -g @github/copilot), then run `copilot login`.";

export const copilotAgent = (executable?: string): AcpAgent => ({
  kind: "copilot",
  name: "GitHub Copilot",
  installHint: COPILOT_HINT,
  launch: ({ runtimeMode, readOnly, probe }) =>
    Effect.map(onPath("copilot", ["copilot"], COPILOT_HINT, executable), (command) => ({
      command,
      // Full access: Copilot runs tools without asking; otherwise it asks through ACP.
      args: ["--acp", ...(!probe && !readOnly && runtimeMode === "full-access" ? ["--allow-all-tools"] : [])],
    })),
  authMethod: (methods) => methods.find((m) => m.id === "copilot-login")?.id ?? methods[0]?.id ?? null,
});

// --- Antigravity ------------------------------------------------------------------
// Google's Antigravity agent is a separate ACP server (not the Antigravity app or CLI),
// downloaded on first use from Google's release bucket and checked against its sha256.

const ANTIGRAVITY_VERSION = "1.4.5";
const ANTIGRAVITY_RELEASES: Record<string, { url: string; sha256: string }> = {
  "darwin-arm64": {
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip",
    sha256: "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f",
  },
  "darwin-x64": {
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-x86_64.zip",
    sha256: "b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a",
  },
  "linux-x64": {
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip",
    sha256: "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b",
  },
  "linux-arm64": {
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip",
    sha256: "7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056",
  },
};

const ANTIGRAVITY_HINT = "Antigravity downloads Google's ACP server on first use; sign in with your Google account when asked.";

export interface AntigravityInstall {
  readonly executable: string;
  readonly harness: string;
}

/** Where Antigravity lives under Apollo's data folder, and whether it is there. */
export const antigravityPaths = (stateDir: string) => {
  const dir = join(stateDir, "antigravity", ANTIGRAVITY_VERSION);
  return {
    dir,
    executable: join(dir, "agy_acp_server.par"),
    harness: join(dir, "localharness_external"),
    home: join(stateDir, "antigravity", "home"),
    version: ANTIGRAVITY_VERSION,
  };
};

const sha256 = async (file: string) => {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
};

const unzip = (zip: string, dir: string) =>
  new Promise<void>((resolve, reject) =>
    execFile("unzip", ["-o", "-q", zip, "-d", dir], { timeout: 5 * 60_000 }, (error, _out, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(),
    ),
  );

/** Installs in progress, so a second caller (or one that timed out and retried) waits for the same download. */
const installing = new Map<string, Promise<AntigravityInstall>>();

/** Downloads and unpacks the pinned Antigravity ACP server, unless it is already there. */
export const installAntigravity = (stateDir: string) =>
  Effect.tryPromise({
    try: () => {
      const running = installing.get(stateDir);
      if (running) return running;
      const install = downloadAntigravity(stateDir).finally(() => installing.delete(stateDir));
      installing.set(stateDir, install);
      return install;
    },
    catch: (error) => new ProviderError({ provider: "antigravity", message: `Could not install Antigravity: ${(error as Error).message}` }),
  });

const downloadAntigravity = async (stateDir: string): Promise<AntigravityInstall> => {
  const paths = antigravityPaths(stateDir);
  if (existsSync(paths.executable) && existsSync(paths.harness)) return paths;
  const release = ANTIGRAVITY_RELEASES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`Antigravity has no build for ${process.platform}-${process.arch}`);
  mkdirSync(paths.dir, { recursive: true });
  const zip = join(paths.dir, "download.zip");
  const response = await fetch(release.url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(zip));
  const digest = await sha256(zip);
  if (digest !== release.sha256) {
    rmSync(zip, { force: true });
    throw new Error("the download did not match its checksum");
  }
  await unzip(zip, paths.dir);
  rmSync(zip, { force: true });
  for (const file of [paths.executable, paths.harness]) {
    if (!existsSync(file)) throw new Error(`${file} is missing from the download`);
    chmodSync(file, 0o755);
  }
  return paths;
};

/** Uses an `agy_acp_server` on PATH when there is one, else Apollo's own copy (installed on demand). */
const resolveAntigravity = (stateDir: string) =>
  Effect.suspend(() => {
    const onPathServer = findExecutable(["agy_acp_server.par", "agy_acp_server"]);
    if (onPathServer) {
      const harness = join(onPathServer, "..", "localharness_external");
      if (existsSync(harness)) return Effect.succeed({ executable: onPathServer, harness });
    }
    return installAntigravity(stateDir);
  });

const antigravityAuth = () => (process.env.GEMINI_API_KEY ? "gemini-api-key" : "oauth-personal");

export const antigravityAgent = (stateDir: string): AcpAgent => ({
  kind: "antigravity",
  name: "Antigravity",
  installHint: ANTIGRAVITY_HINT,
  clientInfo: { name: "zed", version: "0.0.0" },
  launch: () =>
    Effect.map(resolveAntigravity(stateDir), (install): AcpLaunch => {
      // A private profile: its own sign-in, settings and temp files.
      const { home } = antigravityPaths(stateDir);
      const acpDir = join(home, "antigravity-acp");
      mkdirSync(join(acpDir, "tmp"), { recursive: true, mode: 0o700 });
      writeFileSync(join(acpDir, "settings.json"), `${JSON.stringify({ auth: { type: antigravityAuth() } }, null, 2)}\n`);
      return {
        command: install.executable,
        args: process.platform === "linux" ? ["--uid="] : [],
        env: {
          GEMINI_HOME: home,
          AGY_ACP_FORCE_FILE_STORAGE: "1",
          ANTIGRAVITY_HARNESS_PATH: install.harness,
          PYTHONUNBUFFERED: "1",
          TMPDIR: join(acpDir, "tmp"),
        },
      };
    }),
  authMethod: (methods) => methods.find((m) => m.id === antigravityAuth())?.id ?? methods[0]?.id ?? null,
  authenticateEagerly: true,
  preferResume: true,
  assumeHttpMcp: false,
  modeFor: (mode, readOnly) => (readOnly ? "default" : mode === "full-access" ? "yolo" : mode === "auto" ? "auto_edit" : "default"),
  sessionMeta: () => ({ antigravity: { disabledTools: ["run_workflow"] } }),
  signInUrl: (line) => /(https:\/\/accounts\.google\.com\/\S+)/.exec(line)?.[1] ?? null,
});

export interface AcpAgentsConfig {
  /** Apollo's folder for agent installs and profiles (Antigravity). */
  readonly stateDir: string;
  readonly executables?: Partial<Record<"cursor" | "grok" | "opencode" | "copilot", string | undefined>>;
}

export const makeAcpProviders = (config: AcpAgentsConfig): Record<"cursor" | "grok" | "opencode" | "antigravity" | "copilot", Provider> => ({
  cursor: makeAcpProvider(cursorAgent(config.executables?.cursor)),
  grok: makeAcpProvider(grokAgent(config.executables?.grok)),
  opencode: makeAcpProvider(opencodeAgent(config.executables?.opencode)),
  antigravity: makeAcpProvider(antigravityAgent(config.stateDir)),
  copilot: makeAcpProvider(copilotAgent(config.executables?.copilot)),
});
