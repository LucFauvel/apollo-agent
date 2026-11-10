import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppChange, BotId, SessionId } from "@apollo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserCore, VIEWPORT_PRESETS, normalizeUrl } from "./Browser.ts";
import { findBrowser } from "./Chrome.ts";

describe("normalizeUrl", () => {
  it("adds a scheme: https for hosts, http for local servers", () => {
    expect(normalizeUrl("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeUrl("127.0.0.1:8080/a")).toBe("http://127.0.0.1:8080/a");
    expect(normalizeUrl("http://example.com")).toBe("http://example.com/");
    expect(normalizeUrl("")).toBe("about:blank");
  });

  it("refuses non-web schemes", () => {
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow(/only http/);
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow(/only http/);
  });
});

const PAGE = `<!doctype html><html><head><title>Test form</title></head><body>
<nav aria-label="Main"><a href="/second">Second page</a></nav>
<main>
  <h1>Sign up</h1>
  <p>Fill in the form.</p>
  <label for="name">Name</label><input id="name" placeholder="Your name">
  <select id="plan" aria-label="Plan"><option value="free">Free</option><option value="pro">Pro</option></select>
  <button id="go" onclick="document.getElementById('out').textContent = 'Hello ' + document.getElementById('name').value + ' on ' + document.getElementById('plan').value">Submit</button>
  <button onclick="alert('careful'); console.error('boom')">Warn</button>
  <div id="out"></div>
  <div style="display:none"><button>Hidden</button></div>
</main></body></html>`;

const executable = findBrowser(process.env.APOLLO_BROWSER_BIN);

// Real Chromium on shared CI runners is slow to start and to render: pay the cold
// start once in beforeAll, give each test a runner-sized budget, and have every
// test open its own page so one timeout cannot cascade "no tab is open" onward.
// Deliberately NOT gated out of hosted CI: the macOS runner image ships Chrome, and this
// suite is the only end-to-end coverage of the built-in browser. It skips only where no
// Chromium is found (APOLLO_BROWSER_BIN points at one explicitly).
describe.skipIf(!executable)("built-in browser (real Chromium)", { timeout: 60_000 }, () => {
  const bot = "bot-1" as BotId;
  const session = "session-1" as SessionId;
  let server: Server;
  let base: string;
  let dataDir: string;
  const changes: Array<AppChange> = [];
  let core: BrowserCore;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(req.url === "/second" ? "<title>Second</title><h1>Second page</h1>" : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    dataDir = mkdtempSync(join(tmpdir(), "apollo-browser-"));
    core = new BrowserCore({ executable, headless: true, dataDir, publish: (c) => void changes.push(c) });
    // Launch Chromium before any test asserts, so no test's budget is spent on the cold start.
    await core.open(bot, session, "about:blank", false);
    await core.close(bot, session);
  }, 120_000);

  afterAll(async () => {
    await core?.shutdown();
    server?.close();
    // Chromium may still flush to the profile dir after shutdown resolves; retry so
    // teardown doesn't fail the run with ENOTEMPTY on slower runners.
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it("opens a page, reads it, and drives a form by ref", async () => {
    const opened = await core.open(bot, session, base, false);
    expect(opened.title).toBe("Test form");
    expect(changes.some((c) => c._tag === "BrowserTabUpserted")).toBe(true);

    const snap = await core.snapshot(bot, session);
    expect(snap.content).toContain("# Sign up");
    expect(snap.content).toContain('- navigation "Main":');
    expect(snap.content).not.toContain("Hidden");
    const ref = (pattern: RegExp) => snap.content.match(pattern)?.[1];
    const name = ref(/textbox "Name" \[ref=(e\d+)\]/);
    const plan = ref(/combobox "Plan" value="Free" options: "Free", "Pro" \[ref=(e\d+)\]/);
    const submit = ref(/button "Submit" \[ref=(e\d+)\]/);
    expect(name && plan && submit).toBeTruthy();

    await core.act(bot, session, undefined, { action: "type", ref: name, text: "Ada" });
    await core.act(bot, session, undefined, { action: "select", ref: plan, values: ["Pro"] });
    await core.act(bot, session, undefined, { action: "click", ref: submit });
    const waited = await core.waitFor(bot, session, undefined, { text: "Hello Ada on pro" }, 5000);
    expect(waited.matched).toBe(true);

    const evaluated = await core.evaluateForAgent(bot, session, undefined, "document.getElementById('out').textContent");
    expect(evaluated.value).toBe("Hello Ada on pro");
  });

  it("reports dialogs and console errors, and follows links", async () => {
    await core.open(bot, session, base, false);
    const snap = await core.snapshot(bot, session);
    const warn = snap.content.match(/button "Warn" \[ref=(e\d+)\]/)?.[1];
    const result = await core.act(bot, session, undefined, { action: "click", ref: warn });
    expect(result.log.join("\n")).toMatch(/\[dialog\] alert: careful/);
    expect(result.log.join("\n")).toMatch(/\[console.error\] boom/);

    const link = (await core.snapshot(bot, session)).content.match(/link "Second page" → \/second \[ref=(e\d+)\]/)?.[1];
    const moved = await core.act(bot, session, undefined, { action: "click", ref: link });
    expect(moved.navigated).toBe(true);
    expect(moved.title).toBe("Second");

    const back = await core.navigate(bot, session, undefined, undefined, "back");
    expect(back.title).toBe("Test form");
  });

  it("rejects stale refs and other bots' tabs", async () => {
    await core.open(bot, session, base, false);
    await expect(core.act(bot, session, undefined, { action: "click", ref: "e999" })).rejects.toThrow(/unknown ref/);
    const { current } = core.tabsFor(bot, session);
    await expect(core.snapshot("bot-2" as BotId, session, current!)).rejects.toThrow(/another bot/);
  });

  it("renders HTML for a preview, with its height and console output", async () => {
    const html = `<!doctype html><html><body style="margin:0"><div style="height:640px;background:#123">chart</div><script>console.error("missing data")</script></body></html>`;
    const preview = await core.renderHtml(html, 500, "dark");
    expect(existsSync(preview.path)).toBe(true);
    expect(preview.contentHeight).toBe(640);
    expect(preview.log.join("\n")).toMatch(/\[console.error\] missing data/);
    // The preview page is not one of the bot's tabs.
    expect(core.list(bot).every((t) => t.url !== "about:blank" || t.title !== "")).toBe(true);
  });

  it("emulates phones and dark mode, answers dialogs as asked, and records a flow", async () => {
    await core.open(bot, session, base, false);
    const phone = await core.emulate(bot, session, undefined, { ...VIEWPORT_PRESETS.phone, colorScheme: "dark" });
    expect(phone).toMatchObject({ width: 390, height: 844 });
    const dark = await core.evaluateForAgent(bot, session, undefined, "matchMedia('(prefers-color-scheme: dark)').matches");
    expect(JSON.stringify(dark)).toContain("true");

    core.setDialogs(bot, session, undefined, "dismiss", null);
    const asked = await core.evaluateForAgent(bot, session, undefined, "confirm('Delete?')");
    expect(JSON.stringify(asked)).toContain("false");
    core.setDialogs(bot, session, undefined, "auto", "Ada");
    const named = await core.evaluateForAgent(bot, session, undefined, "prompt('Name?')");
    expect(JSON.stringify(named)).toContain("Ada");

    await core.startRecording(bot, session, undefined);
    await new Promise((r) => setTimeout(r, 700));
    const recording = await core.stopRecording(bot, session, undefined);
    expect(recording.frames).toBeGreaterThanOrEqual(2);
    // Phone viewport at 2x pixels.
    expect(recording).toMatchObject({ width: 780, height: 1688 });
    expect(existsSync(join(recording.dir, "0000.jpg"))).toBe(true);
    await expect(core.stopRecording(bot, session, undefined)).rejects.toThrow(/not being recorded/);

    await core.emulate(bot, session, undefined, VIEWPORT_PRESETS.desktop);
  });

  it("saves screenshots and streams frames to the live view", async () => {
    await core.open(bot, session, base, false);
    const shot = await core.screenshot(bot, session, undefined, true);
    expect(existsSync(shot.path)).toBe(true);
    expect(shot.bytes).toBeGreaterThan(1000);

    const { current } = core.tabsFor(bot, session);
    const frame = await new Promise<{ width: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no frame")), 10_000);
      void core.watch(current!, (f) => {
        clearTimeout(timer);
        resolve(f);
      });
    });
    expect(frame.width).toBe(1280);

    await core.close(bot, session);
    expect(core.list(bot)).toHaveLength(0);
    expect(changes.some((c) => c._tag === "BrowserTabClosed")).toBe(true);
  });

  it("closes every tab of a deleted bot, and only that bot's", async () => {
    const other = "bot-2" as BotId;
    const a = await core.open(bot, session, base, true);
    const b = await core.open(bot, session, `${base}/second`, true);
    const kept = await core.open(other, "session-2" as SessionId, base, true);
    changes.length = 0;
    await core.closeForBot(bot);
    expect(core.list(bot)).toHaveLength(0);
    expect(core.list(other).map((t) => t.id)).toEqual([kept.tabId]);
    const closed = changes.flatMap((c) => (c._tag === "BrowserTabClosed" ? [c.tabId] : []));
    expect(closed.sort()).toEqual([a.tabId, b.tabId].sort());
    await core.closeForBot(bot); // nothing left: a no-op
    await core.close(other, null, kept.tabId);
  });
});
