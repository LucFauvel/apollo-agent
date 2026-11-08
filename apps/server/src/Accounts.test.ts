import { chmodSync, existsSync, lstatSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderKind } from "@apollo/contracts";
import { ProviderKind as Kinds } from "@apollo/contracts";
import type { Provider } from "@apollo/providers";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AppSettings from "./AppSettings.ts";
import * as Accounts from "./Accounts.ts";
import { ServerConfig } from "./Config.ts";
import * as Database from "./Database.ts";
import * as SessionManager from "./SessionManager.ts";
import * as Store from "./Store.ts";

const dataDir = mkdtempSync(join(tmpdir(), "apollo-accounts-"));

/** A `claude` that signs in when given the code "good", per CLAUDE_CONFIG_DIR. */
const fakeClaude = join(dataDir, "claude");
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = process.env.CLAUDE_CONFIG_DIR, file = path.join(dir, "logged-in");
const [cmd, sub] = process.argv.slice(2);
if (cmd === "auth" && sub === "status") {
  const on = fs.existsSync(file);
  console.log(JSON.stringify({ loggedIn: on, email: on ? "me@work.com" : undefined, orgName: on ? "Work Inc" : undefined, subscriptionType: on ? "team" : undefined }));
} else if (cmd === "auth" && sub === "logout") {
  fs.rmSync(file, { force: true });
} else if (cmd === "auth" && sub === "login") {
  console.log("Opening browser to sign in…");
  console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x");
  process.stdin.once("data", (d) => {
    if (d.toString().trim() !== "good") { console.error("Invalid code"); process.exit(1); }
    fs.writeFileSync(file, "1");
    process.exit(0);
  });
}
`,
);
chmodSync(fakeClaude, 0o755);

/** A `codex` whose browser sign-in finishes on its own, writing a ChatGPT login to CODEX_HOME. */
const fakeCodex = join(dataDir, "codex");
const idToken = ["x", Buffer.from(JSON.stringify({ email: "me@home.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })).toString("base64url"), "y"].join(".");
writeFileSync(
  fakeCodex,
  `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const file = path.join(process.env.CODEX_HOME, "auth.json");
const [cmd, sub] = process.argv.slice(2);
if (cmd === "login" && sub === "status") {
  if (fs.existsSync(file)) console.log("Logged in using ChatGPT"); else { console.error("Not logged in"); process.exit(1); }
} else if (cmd === "logout") {
  fs.rmSync(file, { force: true });
} else if (cmd === "login") {
  console.log("Starting local login server on http://localhost:1455.");
  console.log("If your browser did not open, navigate to this URL to authenticate:\\n\\nhttps://auth.openai.com/oauth/authorize?client_id=x");
  setTimeout(() => { fs.writeFileSync(file, JSON.stringify({ tokens: { id_token: ${JSON.stringify(idToken)} } })); process.exit(0); }, 200);
}
`,
);
chmodSync(fakeCodex, 0o755);

const idle = (kind: ProviderKind): Provider => ({ kind, listModels: Effect.succeed([]), open: () => Effect.die("not used") });

const layer = Accounts.layer.pipe(
  Layer.provideMerge(SessionManager.layer),
  Layer.provideMerge(Layer.succeed(SessionManager.Providers, Object.fromEntries(Kinds.literals.map((k) => [k, idle(k)])) as Record<ProviderKind, Provider>)),
  Layer.provideMerge(AppSettings.layer),
  Layer.provideMerge(Store.layer),
  Layer.provideMerge(Database.layerMemory),
  Layer.provideMerge(
    Layer.succeed(ServerConfig, {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      webDistDir: null,
      baseUrl: "http://127.0.0.1:0",
      claudeExecutable: fakeClaude,
      browser: { executable: undefined, headless: true },
      llamaCpp: { baseUrl: "http://127.0.0.1:8080", apiKey: null },
      codexExecutable: fakeCodex,
      tailnetAddon: undefined,
      allowedOrigins: [],
      publicUrl: "http://127.0.0.1:0",
      desktopBootstrapToken: undefined,
      storage: { budgetBytes: 1e9, archiveLimit: 2000, detailRetentionMs: 30 * 86_400_000 },
    }),
  ),
);

describe("Accounts", () => {
  it.live("adds an account, signs it in with a pasted code, and removes it", () =>
    Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;

      const work = yield* accounts.add("claude", "Work");
      expect(work).toMatchObject({ name: "Work", loggedIn: false, signIn: null });
      const dir = Accounts.accountDir(dataDir, "claude", work.id);
      expect(existsSync(dir)).toBe(true);
      expect(yield* accounts.add("claude", "work").pipe(Effect.flip)).toMatchObject({ message: expect.stringMatching(/already/) });

      // Sign-in shows the page, waits for the code; a wrong code is reported.
      const started = yield* accounts.signIn(work.id);
      expect(started.signIn?.url).toBe("https://claude.com/cai/oauth/authorize?code=true&state=x");
      expect(yield* accounts.submitCode(work.id, "bad").pipe(Effect.flip)).toMatchObject({ message: "Invalid code" });
      yield* accounts.signIn(work.id);
      yield* accounts.submitCode(work.id, "good");
      expect((yield* accounts.list)[0]).toMatchObject({ loggedIn: true, email: "me@work.com", orgName: "Work Inc", plan: "team", signIn: null });

      // A bot on the account runs Claude Code in its folder, without inherited credentials.
      const bot = yield* manager.createBot({
        name: "Atlas",
        instructions: "",
        cwd: "/tmp",
        main: { provider: "claude" },
        defaultWorker: { provider: "claude" },
        runtimeMode: "full-access",
        autoLearn: false,
        claudeAccountId: work.id,
      });
      expect(bot.claudeAccountId).toBe(work.id);
      expect(Accounts.accountEnvironment(dataDir, "claude", work.id)).toEqual({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined });

      // Removing it signs out, deletes the folder and moves the bot back to this machine's login.
      yield* accounts.remove(work.id);
      expect(yield* accounts.list).toEqual([]);
      expect(existsSync(dir)).toBe(false);
      expect((yield* store.getBot(bot.id)).claudeAccountId).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("signs in a Codex account through the browser and runs Codex from its folder", () =>
    Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const home = yield* accounts.add("codex", "Personal");
      expect(home).toMatchObject({ provider: "codex", loggedIn: false });
      const started = yield* accounts.signIn(home.id);
      expect(started.signIn?.url).toBe("https://auth.openai.com/oauth/authorize?client_id=x");
      let after = started;
      for (let i = 0; i < 50 && !after.loggedIn; i++) {
        yield* Effect.sleep("50 millis");
        after = (yield* accounts.list).find((a) => a.id === home.id)!;
      }
      expect(after).toMatchObject({ loggedIn: true, email: "me@home.com", plan: "plus", signIn: null });
      expect(Accounts.accountEnvironment(dataDir, "codex", home.id)).toEqual({
        CODEX_HOME: Accounts.accountDir(dataDir, "codex", home.id),
        OPENAI_API_KEY: undefined,
      });
      yield* accounts.remove(home.id);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it("links what is shared from ~/.claude, not the login", () => {
    // Only files that exist are linked; the account's own .claude.json is never a link.
    const dir = Accounts.accountDir(dataDir, "claude", "none");
    expect(() => lstatSync(join(dir, ".claude.json"))).toThrow();
  });
});
