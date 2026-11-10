import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountProvider, AgentCliState } from "@apollo/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AgentClis from "./AgentClis.ts";
import { deviceCode, signInUrl } from "./cliLogin.ts";
import { ServerConfig, type ServerConfigShape } from "./Config.ts";

const config = (dataDir: string, claudeBundled: boolean): ServerConfigShape => ({
  host: "127.0.0.1",
  port: 0,
  dataDir,
  webDistDir: null,
  baseUrl: "http://127.0.0.1:0",
  claudeExecutable: undefined,
  codexExecutable: undefined,
  claudeBundled,
  browser: { executable: undefined, headless: true },
  llamaCpp: { baseUrl: "http://127.0.0.1:8080", apiKey: null },
  tailnetAddon: undefined,
  allowedOrigins: [],
  publicUrl: "http://127.0.0.1:0",
  desktopBootstrapToken: undefined,
  storage: { budgetBytes: 1e9, archiveLimit: 2000, detailRetentionMs: 30 * 86_400_000 },
});

/** A `claude` that signs in when given the code "good", keeping its login under HOME. */
const fakeClaude = `#!${process.execPath}
const fs = require("fs"), path = require("path");
const file = path.join(process.env.HOME, ".claude", "logged-in");
const [cmd, sub] = process.argv.slice(2);
if (cmd === "auth" && sub === "status") {
  const on = fs.existsSync(file);
  console.log(JSON.stringify({ loggedIn: on, email: on ? "me@home.com" : undefined, subscriptionType: on ? "max" : undefined }));
} else if (cmd === "auth" && sub === "login") {
  console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x");
  process.stdin.once("data", (d) => {
    if (d.toString().trim() !== "good") { console.error("Invalid code"); process.exit(1); }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "1");
    process.exit(0);
  });
}
`;

const idToken = ["x", Buffer.from(JSON.stringify({ email: "me@home.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })).toString("base64url"), "y"].join(".");

/** A `codex` whose device sign-in shows a page and a code, then finishes by itself. */
const fakeCodex = `#!${process.execPath}
const fs = require("fs"), path = require("path");
const dir = process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), file = path.join(dir, "auth.json");
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  if (fs.existsSync(file)) console.log("Logged in using ChatGPT"); else { console.error("Not logged in"); process.exit(1); }
} else if (args[0] === "login" && args[1] === "--device-auth") {
  console.log("\\x1b[1mFollow these steps to sign in with ChatGPT using device code authorization:\\x1b[0m");
  console.log("1. Open this link in your browser and sign in to your account\\n   \\x1b[94mhttps://auth.openai.com/codex/device\\x1b[0m");
  console.log("2. Enter this one-time code \\x1b[90m(expires in 15 minutes)\\x1b[0m\\n   \\x1b[94mABCD-12345\\x1b[0m");
  setTimeout(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ tokens: { id_token: ${JSON.stringify(idToken)} } }));
    process.exit(0);
  }, 800);
}
`;

/** Installers like the official ones: progress lines, then the CLI in ~/.local/bin. */
const installerFor = (cli: string) => `set -e
echo "Downloading..."
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/${cli === fakeClaude ? "claude" : "codex"}" <<'APOLLO_EOF'
${cli}APOLLO_EOF
chmod +x "$HOME/.local/bin/${cli === fakeClaude ? "claude" : "codex"}"
echo "✔ Installed"
`;

const setup = (scripts: Record<string, string>, claudeBundled = false) => {
  const home = mkdtempSync(join(tmpdir(), "apollo-clis-"));
  const fetched: Array<string> = [];
  const layer = AgentClis.layerWith({
    env: { HOME: home, PATH: "/usr/bin:/bin", CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: undefined },
    platform: "darwin",
    fetchScript: async (url) => {
      fetched.push(url);
      const script = scripts[url];
      if (script === undefined) throw new Error("offline");
      return script;
    },
  }).pipe(Layer.provide(Layer.succeed(ServerConfig, config(home, claudeBundled))));
  return { home, fetched, layer };
};

const settle = (provider: AccountProvider, done: (s: AgentCliState) => boolean) =>
  Effect.gen(function* () {
    const clis = yield* AgentClis.AgentClis;
    for (let i = 0; i < 100; i++) {
      const state = (yield* clis.state).find((s) => s.provider === provider)!;
      if (done(state)) return state;
      yield* Effect.sleep("100 millis");
    }
    throw new Error(`${provider} did not settle: ${JSON.stringify(yield* clis.state)}`);
  });

describe("AgentClis", () => {
  it.live("installs Claude Code with its official installer, then signs this computer in", () => {
    const { home, fetched, layer } = setup({ "https://claude.ai/install.sh": installerFor(fakeClaude) });
    return Effect.gen(function* () {
      const clis = yield* AgentClis.AgentClis;
      const first = yield* clis.watch.pipe(Stream.take(1), Stream.runCollect);
      expect(first[0]!.map((s) => [s.provider, s.executable, s.bundled])).toEqual([
        ["claude", null, false],
        ["codex", null, false],
      ]);
      expect(clis.sessionExecutable("claude")).toBeUndefined();
      expect(yield* clis.signIn("claude", false).pipe(Effect.flip)).toMatchObject({ message: "Install Claude Code first." });

      const started = yield* clis.install("claude");
      expect(started.install).not.toBeNull();
      const installed = yield* settle("claude", (s) => s.install === null && s.login !== null);
      const exe = join(home, ".local", "bin", "claude");
      expect(installed).toMatchObject({ executable: exe, installError: null, login: { loggedIn: false } });
      expect(fetched).toEqual(["https://claude.ai/install.sh"]);
      // Sessions pick it up without a restart.
      expect(clis.sessionExecutable("claude")).toBe(exe);
      expect(yield* clis.install("claude").pipe(Effect.flip)).toMatchObject({ message: expect.stringMatching(/already installed/) });

      const signingIn = yield* clis.signIn("claude", true);
      expect(signingIn.signIn).toMatchObject({ url: "https://claude.com/cai/oauth/authorize?code=true&state=x", needsCode: true, error: null });
      expect(yield* clis.submitCode("claude", "bad").pipe(Effect.flip)).toMatchObject({ message: "Invalid code" });
      yield* clis.signIn("claude", true);
      const done = yield* clis.submitCode("claude", "good");
      expect(done).toMatchObject({ signIn: null, login: { loggedIn: true, email: "me@home.com", plan: "max" } });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("signs Codex in with a device code shown on another device", () => {
    const { layer } = setup({ "https://chatgpt.com/codex/install.sh": installerFor(fakeCodex) });
    return Effect.gen(function* () {
      const clis = yield* AgentClis.AgentClis;
      yield* clis.install("codex");
      yield* settle("codex", (s) => s.install === null && s.login !== null);
      expect(clis.sessionExecutable("codex")).toMatch(/\.local\/bin\/codex$/);

      const started = yield* clis.signIn("codex", true);
      expect(started.signIn).toEqual({ url: "https://auth.openai.com/codex/device", userCode: "ABCD-12345", needsCode: false, error: null });
      const done = yield* settle("codex", (s) => s.signIn === null && s.login?.loggedIn === true);
      expect(done.login).toEqual({ loggedIn: true, email: "me@home.com", orgName: null, plan: "plus" });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("reports an installer that fails, one that cannot be downloaded, and one that installs nothing", () => {
    const { layer } = setup({
      "https://claude.ai/install.sh": 'echo "Checking..."\necho "Unsupported operating system: Plan9" >&2\nexit 1\n',
      "https://chatgpt.com/codex/install.sh": 'echo "All done"\n',
    });
    return Effect.gen(function* () {
      const clis = yield* AgentClis.AgentClis;
      yield* clis.install("claude");
      const failed = yield* settle("claude", (s) => s.install === null);
      expect(failed.installError).toBe("Unsupported operating system: Plan9");

      yield* clis.install("codex");
      const empty = yield* settle("codex", (s) => s.install === null);
      expect(empty.installError).toMatch(/finished, but codex is not in/);
      expect(yield* clis.awaitInstall("codex").pipe(Effect.flip)).toMatchObject({ message: expect.stringMatching(/not in/) });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("keeps development's bundled Claude Code for sessions", () => {
    const { home, layer } = setup({}, true);
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "claude"), fakeClaude);
    chmodSync(join(home, ".local", "bin", "claude"), 0o755);
    return Effect.gen(function* () {
      const clis = yield* AgentClis.AgentClis;
      expect(clis.sessionExecutable("claude")).toBeUndefined();
      expect(clis.executable("claude")).toBe(join(home, ".local", "bin", "claude"));
      expect((yield* clis.state)[0]).toMatchObject({ bundled: true });
      const failed = yield* clis.install("codex").pipe(Effect.andThen(settle("codex", (s) => s.install === null)));
      expect(failed.installError).toMatch(/Could not download the installer: offline/);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it("reads sign-in pages and device codes from CLI output", () => {
    expect(signInUrl("Starting local login server on http://localhost:1455.\nhttps://auth.openai.com/oauth/authorize?client_id=x")).toBe(
      "https://auth.openai.com/oauth/authorize?client_id=x",
    );
    expect(signInUrl("   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m")).toBe("https://auth.openai.com/codex/device");
    expect(deviceCode("Enter this one-time code\n   \x1b[94mWXYZ-9876\x1b[0m")).toBe("WXYZ-9876");
    expect(deviceCode("no code here, just https://example.com")).toBeNull();
  });
});
