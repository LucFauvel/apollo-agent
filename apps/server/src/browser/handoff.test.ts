import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ProviderKind } from "@apollo/contracts";
import { ProviderKind as Kinds } from "@apollo/contracts";
import type { Provider } from "@apollo/providers";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as AppSettings from "../AppSettings.ts";
import { ServerConfig } from "../Config.ts";
import * as Database from "../Database.ts";
import * as SessionManager from "../SessionManager.ts";
import * as Store from "../Store.ts";
import * as Browser from "./Browser.ts";
import { findBrowser } from "./Chrome.ts";

const executable = findBrowser(process.env.APOLLO_BROWSER_BIN);
const dataDir = mkdtempSync(join(tmpdir(), "apollo-handoff-"));

const idle = (kind: ProviderKind): Provider => ({
  kind,
  listModels: Effect.succeed([]),
  open: () => Effect.die("not used"),
});

const layer = Browser.layer.pipe(
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
      claudeExecutable: undefined,
      browser: { executable: executable ?? undefined, headless: true },
      llamaCpp: { baseUrl: "http://127.0.0.1:8080", apiKey: null },
      codexExecutable: undefined,
      tailnetAddon: undefined,
      allowedOrigins: [],
      publicUrl: "http://127.0.0.1:0",
      desktopBootstrapToken: undefined,
      storage: { budgetBytes: 1e9, archiveLimit: 2000, detailRetentionMs: 30 * 86_400_000 },
    }),
  ),
);

const page = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ url: string; close: () => void }>((resolve) => {
        const server = createServer((_req, res) => res.end("<title>Sign in</title><h1>Sign in</h1>"));
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve({ url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`, close: () => server.close() });
        });
      }),
  ),
  (server) => Effect.sync(server.close),
);

describe.skipIf(!executable)("browser handoff", () => {
  it.live("shows the tab to the user and waits until they say they are done", () =>
    Effect.gen(function* () {
      const manager = yield* SessionManager.SessionManager;
      const store = yield* Store.Store;
      const browser = yield* Browser.Browser;
      const { url } = yield* page;
      const bot = yield* manager.createBot({
        name: "Atlas",
        instructions: "",
        cwd: "/tmp",
        main: { provider: "claude" },
        defaultWorker: { provider: "codex" },
        runtimeMode: "full-access",
        autoLearn: false,
      });
      const sessionId = bot.mainSessionId;
      const tab = yield* browser.open(bot.id, sessionId, url, false);

      const events = () => Effect.map(store.listEvents(sessionId, 0), (list) => list.map((e) => e.event));
      const waiting = yield* browser.handoff(bot.id, sessionId, undefined, "Solve the CAPTCHA", 60_000).pipe(Effect.forkChild);
      let asked: Extract<AgentEvent, { _tag: "BrowserHandoff" }> | undefined;
      for (let i = 0; i < 100 && !asked; i++) {
        asked = (yield* events()).find((e): e is Extract<AgentEvent, { _tag: "BrowserHandoff" }> => e._tag === "BrowserHandoff");
        if (!asked) yield* Effect.sleep("20 millis");
      }
      expect(asked).toMatchObject({ tabId: tab.tabId, url, reason: "Solve the CAPTCHA" });

      // A wrong session cannot answer; the right one can, with a note.
      const wrong = yield* browser.respondHandoff("other" as typeof sessionId, asked!.requestId, "done", null).pipe(Effect.flip);
      expect(wrong.message).toMatch(/no longer waiting/);
      yield* browser.respondHandoff(sessionId, asked!.requestId, "done", "signed in as work account");
      expect(yield* Fiber.join(waiting)).toEqual({ tabId: tab.tabId, url, title: "Sign in", note: "signed in as work account" });
      expect((yield* events()).at(-1)).toEqual({ _tag: "BrowserHandoffResolved", requestId: asked!.requestId, outcome: "done" });

      // Declining fails the agent's call with a reason it can act on.
      const second = yield* browser.handoff(bot.id, sessionId, tab.tabId, "Approve the payment", 60_000).pipe(Effect.flip, Effect.forkChild);
      let next: string | undefined;
      for (let i = 0; i < 100 && !next; i++) {
        next = (yield* events()).filter((e) => e._tag === "BrowserHandoff").at(1)?.requestId;
        if (!next) yield* Effect.sleep("20 millis");
      }
      yield* browser.respondHandoff(sessionId, next!, "cancelled", null);
      expect((yield* Fiber.join(second)).message).toMatch(/declined/);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
