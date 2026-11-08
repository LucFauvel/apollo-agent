import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ApolloError,
  type AppChange,
  type BotId,
  type BrowserFrame,
  type BrowserInput,
  type BrowserStatus,
  type BrowserTab,
  type SessionId,
} from "@apollo/contracts";
import type { ChildProcess } from "node:child_process";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../Config.ts";
import { SessionManager } from "../SessionManager.ts";
import { Store } from "../Store.ts";
import { Cdp } from "./Cdp.ts";
import { findBrowser, launchBrowser, stopBrowser } from "./Chrome.ts";
import { PAGE_SCRIPT } from "./pageScript.ts";

const VIEWPORT = { width: 1280, height: 800 };
/** The browser quits after this long without open tabs. */
const IDLE_SHUTDOWN_MS = 10 * 60_000;
const SNAPSHOT_MAX_CHARS = 24_000;
const EVALUATE_MAX_CHARS = 64_000;
const LOG_LIMIT = 50;
const SCREENSHOTS_KEPT = 40;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A user-facing failure: shown to the agent or the UI as is. */
export class BrowserError extends Error {}

const LOCAL_HOST = /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\]|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|[\w-]+\.(local|localhost|test))$/i;

/** `example.com` → `https://example.com`, `localhost:3000` → `http://localhost:3000`. */
export const normalizeUrl = (input: string): string => {
  const raw = input.trim();
  if (raw === "" || raw === "about:blank") return "about:blank";
  // `host:port` parses as a URL with scheme `host:`, so only trust a scheme followed by `//` or a known one.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(javascript|data|file|mailto|about|chrome|blob):/i.test(raw);
  let url: URL;
  if (hasScheme) url = new URL(raw);
  else {
    const probe = new URL(`http://${raw}`);
    url = LOCAL_HOST.test(probe.hostname) ? probe : new URL(`https://${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserError(`only http(s) pages can be opened, not ${url.protocol}`);
  }
  return url.toString();
};

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  " ": { code: "Space", keyCode: 32, text: " " },
  Space: { code: "Space", keyCode: 32, text: " " },
};
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
export type Modifier = keyof typeof MODIFIER_BITS;

interface Tab {
  /** Where the mouse is, so clicks travel there like a hand would. */
  mouse?: { x: number; y: number };
  readonly id: string;
  readonly botId: BotId;
  readonly sessionId: SessionId;
  readonly cdpSession: string;
  readonly openedAt: number;
  url: string;
  title: string;
  loading: boolean;
  /** Console errors and warnings, page errors and dialogs since the last snapshot. */
  log: Array<string>;
  frameListeners: Set<(frame: BrowserFrame) => void>;
  /** CSS size of the last screencast frame, to map clicks from the live view. */
  frameSize: { width: number; height: number };
  loadWaiters: Set<() => void>;
  /** How JavaScript dialogs are answered: by Apollo's default rule, or as the agent asked. */
  dialogs: { mode: "auto" | "accept" | "dismiss"; promptText: string | null };
  /** Screenshots taken a few times a second while the agent records a flow. */
  recording: Recording | null;
}

interface Recording {
  readonly id: string;
  readonly dir: string;
  readonly startedAt: number;
  frames: number;
  width: number;
  height: number;
  timer: ReturnType<typeof setInterval> | null;
  capturing: boolean;
}

/** One frame every 250 ms, at most 5 minutes. */
const RECORDING_INTERVAL_MS = 250;
const RECORDING_MAX_FRAMES = 1200;
const RECORDINGS_KEPT = 30;

export const VIEWPORT_PRESETS = {
  phone: { width: 390, height: 844, mobile: true },
  tablet: { width: 820, height: 1180, mobile: true },
  desktop: { width: 1280, height: 800, mobile: false },
} as const;

export interface ActInput {
  readonly action: "click" | "type" | "press" | "hover" | "select" | "scroll";
  readonly ref?: string | undefined;
  readonly selector?: string | undefined;
  readonly text?: string | undefined;
  readonly clear?: boolean | undefined;
  readonly submit?: boolean | undefined;
  readonly key?: string | undefined;
  readonly modifiers?: ReadonlyArray<Modifier> | undefined;
  readonly values?: ReadonlyArray<string> | undefined;
  readonly button?: "left" | "right" | "middle" | undefined;
  readonly clickCount?: number | undefined;
  readonly deltaX?: number | undefined;
  readonly deltaY?: number | undefined;
}

export interface PageSummary {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
}

/** Owns one browser process (started on first use), its tabs, and their live views. */
export class BrowserCore {
  private cdp: Cdp | null = null;
  private child: ChildProcess | null = null;
  private starting: Promise<Cdp> | null = null;
  private readonly tabs = new Map<string, Tab>();
  /** The tab each session last used, so tools can omit `tabId`. */
  private readonly current = new Map<SessionId, string>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;

  private readonly options: {
    readonly executable: string | null;
    readonly headless: boolean;
    readonly dataDir: string;
    readonly publish: (change: AppChange) => void;
  };

  constructor(options: BrowserCore["options"]) {
    this.options = options;
  }

  // -------------------------------------------------------------------------
  // Process

  status(): BrowserStatus {
    return {
      available: this.options.executable !== null,
      executable: this.options.executable,
      running: this.cdp !== null && !this.cdp.isClosed,
      message:
        this.options.executable === null
          ? "No Chrome, Edge, Chromium or Brave found. Install one, or set APOLLO_BROWSER_BIN."
          : this.lastError,
    };
  }

  private ensure(): Promise<Cdp> {
    if (this.cdp && !this.cdp.isClosed) return Promise.resolve(this.cdp);
    if (this.starting) return this.starting;
    const executable = this.options.executable;
    if (!executable) return Promise.reject(new BrowserError(this.status().message!));
    this.starting = (async () => {
      const launched = await launchBrowser(executable, join(this.options.dataDir, "browser", "profile"), {
        headless: this.options.headless,
        ...VIEWPORT,
      });
      const cdp = await Cdp.connect(launched.webSocketUrl);
      this.child = launched.process;
      this.cdp = cdp;
      this.lastError = null;
      cdp.on((method, params, sessionId) => this.onEvent(method, params, sessionId));
      cdp.onClose(() => this.onBrowserClosed());
      launched.process.once("exit", () => cdp.close());
      // The blank page the browser starts with stays open (untracked): without a page
      // the browser has no window, and it refuses to create tabs.
      await cdp.send("Target.setDiscoverTargets", { discover: true });
      return cdp;
    })()
      .catch((error: Error) => {
        this.lastError = error.message;
        throw new BrowserError(`could not start the browser: ${error.message}`);
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private onBrowserClosed() {
    this.cdp = null;
    this.child = null;
    for (const tab of [...this.tabs.values()]) this.forget(tab);
  }

  async shutdown() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const child = this.child;
    this.cdp?.close();
    if (child) await stopBrowser(child);
  }

  private scheduleIdleShutdown() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.tabs.size > 0 || !this.cdp) return;
    this.idleTimer = setTimeout(() => void this.shutdown(), IDLE_SHUTDOWN_MS);
  }

  // -------------------------------------------------------------------------
  // Tabs

  private toTab(tab: Tab): BrowserTab {
    return {
      id: tab.id,
      botId: tab.botId,
      sessionId: tab.sessionId,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      openedAt: tab.openedAt,
    };
  }

  private changed(tab: Tab) {
    this.options.publish({ _tag: "BrowserTabUpserted", tab: this.toTab(tab) });
  }

  private forget(tab: Tab) {
    if (!this.tabs.delete(tab.id)) return;
    if (tab.recording?.timer) clearInterval(tab.recording.timer);
    for (const [session, id] of this.current) if (id === tab.id) this.current.delete(session);
    for (const wake of tab.loadWaiters) wake();
    this.options.publish({ _tag: "BrowserTabClosed", tabId: tab.id, botId: tab.botId });
    this.scheduleIdleShutdown();
  }

  list(botId?: BotId): ReadonlyArray<BrowserTab> {
    return [...this.tabs.values()].filter((t) => !botId || t.botId === botId).map((t) => this.toTab(t));
  }

  /** The tab a call refers to: `tabId`, else the caller's current tab. */
  private pick(botId: BotId, sessionId: SessionId | null, tabId?: string): Tab {
    const id = tabId ?? (sessionId ? this.current.get(sessionId) : undefined);
    const tab = id ? this.tabs.get(id) : undefined;
    if (!tab) {
      throw new BrowserError(
        tabId ? `no open tab ${tabId}; apollo_browser_tabs lists them` : "no tab is open: call apollo_browser_open first",
      );
    }
    if (tab.botId !== botId) throw new BrowserError("that tab belongs to another bot");
    if (sessionId) this.current.set(sessionId, tab.id);
    return tab;
  }

  private async attach(cdp: Cdp, targetId: string, botId: BotId, sessionId: SessionId): Promise<Tab> {
    const { sessionId: cdpSession } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const tab: Tab = {
      id: targetId,
      botId,
      sessionId,
      cdpSession,
      openedAt: Date.now(),
      url: "about:blank",
      title: "",
      loading: false,
      log: [],
      frameListeners: new Set(),
      frameSize: VIEWPORT,
      loadWaiters: new Set(),
      dialogs: { mode: "auto", promptText: null },
      recording: null,
    };
    this.tabs.set(targetId, tab);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const send = (method: string, params: object = {}) => cdp.send(method, params, cdpSession);
    await Promise.all([
      send("Page.enable"),
      send("Runtime.enable"),
      send("Page.setLifecycleEventsEnabled", { enabled: true }),
      send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false, ...this.screen() }),
    ]);
    return tab;
  }

  async open(botId: BotId, sessionId: SessionId, url: string | undefined, newTab: boolean): Promise<PageSummary> {
    const existing = !newTab ? this.current.get(sessionId) : undefined;
    const reuse = existing ? this.tabs.get(existing) : undefined;
    if (reuse && reuse.botId === botId) {
      if (url) await this.navigate(botId, sessionId, reuse.id, url);
      return { tabId: reuse.id, url: reuse.url, title: reuse.title };
    }
    const target = url ? normalizeUrl(url) : "about:blank";
    const cdp = await this.ensure();
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: false });
    const tab = await this.attach(cdp, targetId, botId, sessionId);
    this.current.set(sessionId, tab.id);
    this.changed(tab);
    if (target !== "about:blank") await this.goto(tab, target, 20_000);
    return { tabId: tab.id, url: tab.url, title: tab.title };
  }

  private async goto(tab: Tab, url: string, timeoutMs: number) {
    const loaded = this.waitForLoad(tab, timeoutMs);
    const result = await this.send(tab, "Page.navigate", { url });
    if (result.errorText) throw new BrowserError(`could not open ${url}: ${result.errorText}`);
    // Same-document navigations (anchors) never fire a load event.
    if (result.loaderId) await loaded;
    await this.refreshInfo(tab);
  }

  async navigate(
    botId: BotId,
    sessionId: SessionId | null,
    tabId: string | undefined,
    url: string | undefined,
    history?: "back" | "forward" | "reload",
    timeoutMs = 20_000,
  ): Promise<PageSummary> {
    const tab = this.pick(botId, sessionId, tabId);
    if (history === "reload") {
      const loaded = this.waitForLoad(tab, timeoutMs);
      await this.send(tab, "Page.reload");
      await loaded;
    } else if (history) {
      const { currentIndex, entries } = await this.send(tab, "Page.getNavigationHistory");
      const entry = entries[currentIndex + (history === "back" ? -1 : 1)];
      if (!entry) throw new BrowserError(`there is no page to go ${history} to`);
      const loaded = this.waitForLoad(tab, timeoutMs);
      await this.send(tab, "Page.navigateToHistoryEntry", { entryId: entry.id });
      await loaded;
    } else if (url) {
      await this.goto(tab, normalizeUrl(url), timeoutMs);
    } else {
      throw new BrowserError("pass `url`, or `history`");
    }
    await this.refreshInfo(tab);
    return { tabId: tab.id, url: tab.url, title: tab.title };
  }

  async close(botId: BotId, sessionId: SessionId | null, tabId?: string) {
    const tab = this.pick(botId, sessionId, tabId);
    await this.cdp?.send("Target.closeTarget", { targetId: tab.id }).catch(() => undefined);
    this.forget(tab);
  }

  // -------------------------------------------------------------------------
  // Page access

  private send(tab: Tab, method: string, params: object = {}, timeoutMs?: number): Promise<any> {
    if (!this.cdp) return Promise.reject(new BrowserError("the browser is not running"));
    return this.cdp.send(method, params, tab.cdpSession, timeoutMs);
  }

  /** Runs `expression` in the page with the helpers installed. */
  private async evaluate(tab: Tab, expression: string, timeoutMs = 30_000): Promise<any> {
    const result = await this.send(
      tab,
      "Runtime.evaluate",
      { expression: `${PAGE_SCRIPT};\n${expression}`, returnByValue: true, awaitPromise: true, userGesture: true },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "script error";
      throw new BrowserError(String(description).split("\n")[0]!.replace(/^Error: /, ""));
    }
    return result.result?.value;
  }

  private waitForLoad(tab: Tab, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        tab.loadWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      tab.loadWaiters.add(done);
    });
  }

  private async refreshInfo(tab: Tab) {
    try {
      const info = await this.cdp!.send("Target.getTargetInfo", { targetId: tab.id });
      tab.url = info.targetInfo.url;
      tab.title = info.targetInfo.title;
      this.changed(tab);
    } catch {
      // The tab may have closed meanwhile.
    }
  }

  private drainLog(tab: Tab) {
    const log = tab.log;
    tab.log = [];
    return log;
  }

  async snapshot(botId: BotId, sessionId: SessionId, tabId?: string) {
    const tab = this.pick(botId, sessionId, tabId);
    const page = (await this.evaluate(tab, `window.__apollo.snapshot(${SNAPSHOT_MAX_CHARS})`)) as {
      url: string;
      title: string;
      text: string;
      truncated: boolean;
    };
    return {
      tabId: tab.id,
      url: page.url,
      title: page.title,
      loading: tab.loading,
      content: page.text || "(the page shows no text)",
      truncated: page.truncated,
      log: this.drainLog(tab),
    };
  }

  private target(input: { ref?: string | undefined; selector?: string | undefined }) {
    if (!input.ref && !input.selector) throw new BrowserError("pass `ref` (from apollo_browser_snapshot) or `selector`");
    return `${JSON.stringify(input.ref ?? null)}, ${JSON.stringify(input.selector ?? null)}`;
  }

  private async mouse(tab: Tab, type: string, x: number, y: number, extra: object = {}) {
    await this.send(tab, "Input.dispatchMouseEvent", { type, x, y, ...extra });
  }

  /**
   * A headless browser reports an 800×600 screen around a bigger window, which bot checks
   * notice: report an ordinary desktop screen instead.
   */
  private screen() {
    return this.options.headless ? { screenWidth: 1920, screenHeight: 1080 } : {};
  }

  /**
   * Clicks like a hand: the pointer travels from where it was in a few eased steps, and the
   * button stays down for a moment. Captchas and sign-in pages watch for pointers that
   * teleport and click in zero time.
   */
  private async click(tab: Tab, x: number, y: number, button: "left" | "right" | "middle" = "left", clickCount = 1, modifiers = 0) {
    const from = tab.mouse ?? { x: x + 40 + Math.random() * 80, y: y + 30 + Math.random() * 60 };
    const steps = 6 + Math.floor(Math.random() * 5);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const jitter = i < steps ? (Math.random() - 0.5) * 2 : 0;
      await this.mouse(tab, "mouseMoved", from.x + (x - from.x) * ease + jitter, from.y + (y - from.y) * ease + jitter, { modifiers });
      await sleep(8 + Math.random() * 10);
    }
    tab.mouse = { x, y };
    for (let i = 1; i <= clickCount; i++) {
      await this.mouse(tab, "mousePressed", x, y, { button, clickCount: i, modifiers });
      await sleep(50 + Math.random() * 60);
      await this.mouse(tab, "mouseReleased", x, y, { button, clickCount: i, modifiers });
      if (i < clickCount) await sleep(60);
    }
  }

  private async press(tab: Tab, key: string, modifiers = 0) {
    const known = KEYS[key];
    const single = key.length === 1 ? key : null;
    if (!known && !single) throw new BrowserError(`unknown key "${key}"; use a single character or ${Object.keys(KEYS).join(", ")}`);
    const printable = (known?.text ?? single) && !(modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt));
    const text = printable ? (known?.text ?? single!) : undefined;
    const base = {
      key: known ? (key === "Space" ? " " : key) : single!,
      code: known?.code ?? (single && /[a-z]/i.test(single) ? `Key${single.toUpperCase()}` : single && /\d/.test(single) ? `Digit${single}` : ""),
      windowsVirtualKeyCode: known?.keyCode ?? (single ? single.toUpperCase().charCodeAt(0) : 0),
      modifiers,
    };
    await this.send(tab, "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.send(tab, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async act(botId: BotId, sessionId: SessionId, tabId: string | undefined, input: ActInput) {
    const tab = this.pick(botId, sessionId, tabId);
    const modifiers = (input.modifiers ?? []).reduce((bits, m) => bits | MODIFIER_BITS[m], 0);
    const urlBefore = tab.url;
    let note: string | null = null;

    switch (input.action) {
      case "click":
      case "hover": {
        const point = await this.evaluate(tab, `window.__apollo.point(${this.target(input)})`);
        if (point.covered) note = `another element (${point.covered}) covers the target; the click may land on it`;
        if (input.action === "hover") await this.mouse(tab, "mouseMoved", point.x, point.y, { modifiers });
        else await this.click(tab, point.x, point.y, input.button, Math.min(Math.max(input.clickCount ?? 1, 1), 3), modifiers);
        break;
      }
      case "type": {
        if (input.text === undefined) throw new BrowserError("`text` is required for type");
        if (input.ref || input.selector) {
          const point = await this.evaluate(tab, `window.__apollo.point(${this.target(input)})`);
          await this.click(tab, point.x, point.y);
          await this.evaluate(tab, `window.__apollo.focus(${this.target(input)}, ${input.clear ? "true" : "false"})`);
        }
        if (input.text) await this.send(tab, "Input.insertText", { text: input.text });
        if (input.submit) await this.press(tab, "Enter");
        break;
      }
      case "press": {
        if (!input.key) throw new BrowserError("`key` is required for press");
        await this.press(tab, input.key, modifiers);
        break;
      }
      case "select": {
        if (!input.values?.length) throw new BrowserError("`values` is required for select");
        await this.evaluate(tab, `window.__apollo.select(${this.target(input)}, ${JSON.stringify(input.values)})`);
        break;
      }
      case "scroll": {
        const dx = input.deltaX ?? 0;
        const dy = input.deltaY ?? (input.deltaX ? 0 : 600);
        if (input.ref || input.selector) await this.evaluate(tab, `window.__apollo.scroll(${this.target(input)}, ${dx}, ${dy})`);
        else await this.mouse(tab, "mouseWheel", tab.frameSize.width / 2, tab.frameSize.height / 2, { deltaX: dx, deltaY: dy });
        break;
      }
    }

    // Give the page a moment to react, and a navigation time to finish.
    await sleep(250);
    if (tab.loading) await this.waitForLoad(tab, 10_000);
    await this.refreshInfo(tab);
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      navigated: tab.url !== urlBefore,
      note,
      log: this.drainLog(tab),
    };
  }

  async evaluateForAgent(botId: BotId, sessionId: SessionId, tabId: string | undefined, expression: string) {
    const tab = this.pick(botId, sessionId, tabId);
    const result = await this.send(tab, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      replMode: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new BrowserError(`the script threw: ${String(description).slice(0, 2000)}`);
    }
    const value = result.result?.value;
    const text =
      value === undefined
        ? (result.result?.description ?? "undefined")
        : typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2);
    return {
      value: text.length > EVALUATE_MAX_CHARS ? `${text.slice(0, EVALUATE_MAX_CHARS)}… (truncated)` : text,
    };
  }

  async waitFor(
    botId: BotId,
    sessionId: SessionId,
    tabId: string | undefined,
    condition: { text?: string | undefined; selector?: string | undefined; urlIncludes?: string | undefined },
    timeoutMs: number,
  ) {
    const tab = this.pick(botId, sessionId, tabId);
    if (!condition.text && !condition.selector && !condition.urlIncludes) {
      throw new BrowserError("pass at least one of `text`, `selector` and `urlIncludes`");
    }
    const expression = `window.__apollo.check(${JSON.stringify(condition.text ?? null)}, ${JSON.stringify(
      condition.selector ?? null,
    )}, ${JSON.stringify(condition.urlIncludes ?? null)})`;
    const deadline = Date.now() + timeoutMs;
    let matched = false;
    while (!matched && Date.now() < deadline) {
      matched = Boolean(await this.evaluate(tab, expression).catch(() => false));
      if (!matched) await sleep(250);
    }
    await this.refreshInfo(tab);
    return { matched, tabId: tab.id, url: tab.url, title: tab.title };
  }

  async screenshot(botId: BotId, sessionId: SessionId, tabId: string | undefined, fullPage: boolean) {
    const tab = this.pick(botId, sessionId, tabId);
    let clip: object | undefined;
    if (fullPage) {
      const { cssContentSize } = await this.send(tab, "Page.getLayoutMetrics");
      // Very long pages are capped so the image stays readable and small.
      clip = { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 12_000), scale: 1 };
    }
    const { data } = await this.send(tab, "Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip, captureBeyondViewport: true } : {}),
    });
    const dir = join(this.options.dataDir, "browser", "screenshots");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${tab.id.slice(0, 8)}.png`);
    const bytes = Buffer.from(data, "base64");
    writeFileSync(path, bytes);
    this.pruneScreenshots(dir);
    return { path, tabId: tab.id, url: tab.url, bytes: bytes.length };
  }

  private pruneScreenshots(dir: string) {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({ path: join(dir, f), at: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of files.slice(SCREENSHOTS_KEPT)) rmSync(old.path, { force: true });
  }

  /**
   * Renders a self-contained HTML document in a throwaway page and returns a
   * PNG of it, its content height and its console output, so an agent can
   * check a visual before showing it. The page is not one of the bot's tabs.
   */
  async renderHtml(html: string, width: number, appearance: "dark" | "light") {
    const cdp = await this.ensure();
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: false });
    const log: Array<string> = [];
    let cdpSession: string | null = null;
    const stop = cdp.on((method, params, session) => {
      if (session !== cdpSession) return;
      if (method === "Runtime.consoleAPICalled") {
        const text = (params.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ");
        log.push(`[console.${params.type}] ${text}`.slice(0, 500));
      } else if (method === "Runtime.exceptionThrown") {
        log.push(`[page error] ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "error"}`.slice(0, 500));
      }
    });
    try {
      ({ sessionId: cdpSession } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
      const send = (method: string, params: object = {}) => cdp.send(method, params, cdpSession!);
      await Promise.all([send("Page.enable"), send("Runtime.enable")]);
      await send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: width < 500 });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: appearance }] });
      const { frameTree } = await send("Page.getFrameTree");
      const loaded = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 8000);
        const off = cdp.on((method, _params, session) => {
          if (session === cdpSession && method === "Page.loadEventFired") {
            clearTimeout(timer);
            off();
            resolve();
          }
        });
      });
      await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
      await loaded;
      // Let fonts, images and first animations settle.
      await send("Runtime.evaluate", {
        expression: "Promise.race([Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))]), new Promise((r) => setTimeout(r, 3000))]).then(() => new Promise((r) => setTimeout(r, 300)))",
        awaitPromise: true,
      });
      const { result } = await send("Runtime.evaluate", {
        // The document's own scrollHeight is never less than the viewport; the body's is the content.
        expression:
          "(() => { const b = document.body; if (!b) return 0; const s = getComputedStyle(b); return Math.ceil(b.scrollHeight + parseFloat(s.marginTop) + parseFloat(s.marginBottom)); })()",
        returnByValue: true,
      });
      const contentHeight = Number(result?.value) || 0;
      const { data } = await send("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width, height: Math.min(Math.max(contentHeight, 1), 6000), scale: 1 },
        captureBeyondViewport: true,
      });
      const dir = join(this.options.dataDir, "browser", "screenshots");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-html.png`);
      writeFileSync(path, Buffer.from(data, "base64"));
      this.pruneScreenshots(dir);
      return { path, contentHeight, log };
    } finally {
      stop();
      await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      this.scheduleIdleShutdown();
    }
  }

  /** Viewport size (phone, tablet, desktop or custom) and light/dark preference of a tab. */
  async emulate(
    botId: BotId,
    sessionId: SessionId,
    tabId: string | undefined,
    input: { width?: number | undefined; height?: number | undefined; mobile?: boolean | undefined; colorScheme?: "light" | "dark" | "no-preference" | undefined },
  ) {
    const tab = this.pick(botId, sessionId, tabId);
    if (input.width !== undefined || input.height !== undefined) {
      const width = Math.round(Math.min(Math.max(input.width ?? VIEWPORT.width, 240), 2560));
      const height = Math.round(Math.min(Math.max(input.height ?? VIEWPORT.height, 240), 2560));
      const mobile = input.mobile ?? width < 768;
      await this.send(tab, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile, ...(mobile ? {} : this.screen()) });
      await this.send(tab, "Emulation.setTouchEmulationEnabled", mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      tab.frameSize = { width, height };
    }
    if (input.colorScheme) {
      await this.send(tab, "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: input.colorScheme }] });
    }
    // The screen size set (a page without a mobile viewport tag still lays out at 980px on phones).
    return { tabId: tab.id, width: tab.frameSize.width, height: tab.frameSize.height };
  }

  /** How the tab's JavaScript dialogs are answered from now on. */
  setDialogs(botId: BotId, sessionId: SessionId, tabId: string | undefined, mode: Tab["dialogs"]["mode"], promptText: string | null) {
    const tab = this.pick(botId, sessionId, tabId);
    tab.dialogs = { mode, promptText };
    return { tabId: tab.id, mode, promptText };
  }

  /** Starts recording a tab: a JPEG of the viewport four times a second. */
  async startRecording(botId: BotId, sessionId: SessionId, tabId: string | undefined) {
    const tab = this.pick(botId, sessionId, tabId);
    if (tab.recording) throw new BrowserError("this tab is already being recorded; stop that recording first");
    const root = join(this.options.dataDir, "recordings");
    this.pruneRecordings(root);
    const id = `rec_${randomBytes(6).toString("hex")}`;
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const recording: Recording = { id, dir, startedAt: Date.now(), frames: 0, width: 0, height: 0, timer: null, capturing: false };
    tab.recording = recording;
    const capture = async () => {
      if (recording.capturing || tab.recording !== recording) return;
      recording.capturing = true;
      try {
        const { data } = await this.send(tab, "Page.captureScreenshot", { format: "jpeg", quality: 65 });
        const bytes = Buffer.from(data, "base64");
        // JPEG SOF0/SOF2 marker holds the size; read it once.
        if (recording.width === 0) {
          for (let i = 2; i < bytes.length - 9; i++) {
            if (bytes[i] === 0xff && (bytes[i + 1] === 0xc0 || bytes[i + 1] === 0xc2)) {
              recording.height = bytes.readUInt16BE(i + 5);
              recording.width = bytes.readUInt16BE(i + 7);
              break;
            }
          }
        }
        writeFileSync(join(dir, `${String(recording.frames).padStart(4, "0")}.jpg`), bytes);
        recording.frames++;
        if (recording.frames >= RECORDING_MAX_FRAMES && recording.timer) {
          clearInterval(recording.timer);
          recording.timer = null;
        }
      } catch {
        // A navigation in progress; the next tick tries again.
      } finally {
        recording.capturing = false;
      }
    };
    await capture();
    recording.timer = setInterval(() => void capture(), RECORDING_INTERVAL_MS);
    return { tabId: tab.id, recordingId: id };
  }

  /** Stops a tab's recording; frames stay on disk for the UI to play. */
  async stopRecording(botId: BotId, sessionId: SessionId, tabId: string | undefined) {
    const tab = this.pick(botId, sessionId, tabId);
    const recording = tab.recording;
    if (!recording) throw new BrowserError("this tab is not being recorded");
    if (recording.timer) clearInterval(recording.timer);
    tab.recording = null;
    while (recording.capturing) await new Promise((r) => setTimeout(r, 20));
    const durationMs = Date.now() - recording.startedAt;
    const meta = { recordingId: recording.id, frames: recording.frames, width: recording.width, height: recording.height, durationMs, url: tab.url };
    writeFileSync(join(recording.dir, "meta.json"), JSON.stringify(meta));
    return { ...meta, tabId: tab.id, dir: recording.dir };
  }

  private pruneRecordings(root: string) {
    if (!existsSync(root)) return;
    const dirs = readdirSync(root)
      .map((name) => ({ path: join(root, name), at: statSync(join(root, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of dirs.slice(RECORDINGS_KEPT - 1)) rmSync(old.path, { recursive: true, force: true });
  }

  /** The tab an agent means (its current one when `tabId` is left out). */
  tabForAgent(botId: BotId, sessionId: SessionId, tabId?: string): BrowserTab {
    return this.toTab(this.pick(botId, sessionId, tabId));
  }

  tabsFor(botId: BotId, sessionId: SessionId) {
    return { tabs: this.list(botId), current: this.current.get(sessionId) ?? null };
  }

  // -------------------------------------------------------------------------
  // Live view (UI)

  private tabForUi(tabId: string): Tab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new BrowserError("that tab is closed");
    return tab;
  }

  async watch(tabId: string, listener: (frame: BrowserFrame) => void): Promise<() => void> {
    const tab = this.tabForUi(tabId);
    tab.frameListeners.add(listener);
    if (tab.frameListeners.size === 1) {
      await this.send(tab, "Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height });
    }
    return () => {
      tab.frameListeners.delete(listener);
      if (tab.frameListeners.size === 0 && this.tabs.has(tab.id)) void this.send(tab, "Page.stopScreencast").catch(() => undefined);
    };
  }

  async userInput(tabId: string, input: BrowserInput) {
    const tab = this.tabForUi(tabId);
    const at = (fx: number, fy: number) => ({
      x: Math.min(Math.max(fx, 0), 1) * tab.frameSize.width,
      y: Math.min(Math.max(fy, 0), 1) * tab.frameSize.height,
    });
    switch (input._tag) {
      case "click": {
        const { x, y } = at(input.x, input.y);
        return this.click(tab, x, y);
      }
      case "scroll": {
        const { x, y } = at(input.x, input.y);
        return this.mouse(tab, "mouseWheel", x, y, { deltaX: input.deltaX, deltaY: input.deltaY });
      }
      case "text":
        return void (await this.send(tab, "Input.insertText", { text: input.text }));
      case "key":
        return this.press(tab, input.key);
      case "history":
        return void (await this.navigate(tab.botId, null, tab.id, undefined, input.direction));
    }
  }

  async openForUser(botId: BotId, sessionId: SessionId, url: string): Promise<BrowserTab> {
    const page = await this.open(botId, sessionId, url, true);
    return this.toTab(this.tabs.get(page.tabId)!);
  }

  async navigateForUser(tabId: string, url: string) {
    const tab = this.tabForUi(tabId);
    await this.navigate(tab.botId, null, tab.id, url);
  }

  async closeForUser(tabId: string) {
    const tab = this.tabForUi(tabId);
    await this.close(tab.botId, null, tab.id);
  }

  // -------------------------------------------------------------------------
  // Events

  private onEvent(method: string, params: any, cdpSession: string | undefined) {
    if (method === "Target.targetInfoChanged") {
      const tab = this.tabs.get(params.targetInfo.targetId);
      if (tab && (tab.url !== params.targetInfo.url || tab.title !== params.targetInfo.title)) {
        tab.url = params.targetInfo.url;
        tab.title = params.targetInfo.title;
        this.changed(tab);
      }
      return;
    }
    if (method === "Target.targetCreated") {
      // Pages a tab opens (target=_blank, window.open) join the same bot.
      const info = params.targetInfo;
      const opener = info.openerId ? this.tabs.get(info.openerId) : undefined;
      if (info.type === "page" && opener && !this.tabs.has(info.targetId) && this.cdp) {
        void this.attach(this.cdp, info.targetId, opener.botId, opener.sessionId)
          .then((tab) => {
            tab.url = info.url;
            opener.log.push(`[tab] the page opened a new tab ${tab.id}: ${info.url}`);
            this.changed(tab);
          })
          .catch(() => undefined);
      }
      return;
    }
    if (method === "Target.targetDestroyed" || method === "Target.detachedFromTarget") {
      const tab = this.tabs.get(params.targetId) ?? [...this.tabs.values()].find((t) => t.cdpSession === params.sessionId);
      if (tab) this.forget(tab);
      return;
    }
    const tab = cdpSession ? [...this.tabs.values()].find((t) => t.cdpSession === cdpSession) : undefined;
    if (!tab) return;
    const log = (line: string) => {
      tab.log.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
      if (tab.log.length > LOG_LIMIT) tab.log.shift();
    };
    switch (method) {
      case "Page.screencastFrame": {
        void this.send(tab, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
        tab.frameSize = { width: params.metadata.deviceWidth, height: params.metadata.deviceHeight };
        const frame = { data: params.data, width: params.metadata.deviceWidth, height: params.metadata.deviceHeight };
        for (const listener of tab.frameListeners) listener(frame);
        return;
      }
      case "Page.frameStartedLoading":
        if (!tab.loading) {
          tab.loading = true;
          this.changed(tab);
        }
        return;
      case "Page.loadEventFired":
      case "Page.frameStoppedLoading":
        if (method === "Page.frameStoppedLoading" && params.frameId !== tab.id) return;
        tab.loading = false;
        for (const wake of [...tab.loadWaiters]) wake();
        this.changed(tab);
        return;
      case "Runtime.consoleAPICalled":
        if (params.type === "error" || params.type === "warning" || params.type === "assert") {
          const text = (params.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ");
          log(`[console.${params.type}] ${text}`);
        }
        return;
      case "Runtime.exceptionThrown":
        log(`[page error] ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "uncaught exception"}`);
        return;
      case "Page.javascriptDialogOpening": {
        // Agents cannot see dialogs, so Apollo answers them (as the agent asked, or by
        // default: accept all but prompts) and reports what they said.
        const { mode, promptText } = tab.dialogs;
        const accept = mode === "auto" ? params.type !== "prompt" || promptText !== null : mode === "accept";
        const answer = accept && params.type === "prompt" ? (promptText ?? params.defaultPrompt ?? "") : undefined;
        log(
          `[dialog] ${params.type}: ${params.message} (${accept ? "accepted" : "dismissed"}${answer !== undefined ? ` with "${answer}"` : ""} by Apollo)`,
        );
        void this.send(tab, "Page.handleJavaScriptDialog", { accept, ...(answer !== undefined ? { promptText: answer } : {}) }).catch(
          () => undefined,
        );
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const toApolloError = (error: unknown) =>
  new ApolloError({
    code: error instanceof BrowserError ? "invalid" : "internal",
    message: error instanceof Error ? error.message : String(error),
  });

const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: toApolloError });

/** How long an agent waits for the user to finish in the browser, at most. */
const HANDOFF_MAX_MS = 30 * 60_000;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const manager = yield* SessionManager;
  const store = yield* Store;
  const context = yield* Effect.context<never>();
  const core = new BrowserCore({
    executable: findBrowser(config.browser.executable),
    headless: config.browser.headless,
    dataDir: config.dataDir,
    publish: (change) => Effect.runForkWith(context)(manager.publish(change)),
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => core.shutdown()));

  // --- handoffs: the agent gives the user the browser and waits --------------------
  const handoffs = new Map<string, { sessionId: SessionId; deferred: Deferred.Deferred<{ outcome: "done" | "cancelled"; note: string | null }> }>();
  const handoffResolved = (sessionId: SessionId, requestId: string, outcome: "done" | "cancelled" | "expired") =>
    manager.appendEvent(sessionId, { _tag: "BrowserHandoffResolved", requestId, outcome });

  /** Shows the user the tab with `reason`, notifies them, and waits until they say they are done. */
  const handoff = (botId: BotId, sessionId: SessionId, tabId: string | undefined, reason: string, timeoutMs: number) =>
    Effect.gen(function* () {
      const tab = yield* attempt(async () => core.tabForAgent(botId, sessionId, tabId));
      const text = reason.trim().slice(0, 600);
      if (!text) return yield* new ApolloError({ code: "invalid", message: "`reason` is required: tell the user what to do, e.g. \"Solve the CAPTCHA, then click Done\"" });
      const requestId = `handoff_${randomBytes(12).toString("base64url")}`;
      const deferred = yield* Deferred.make<{ outcome: "done" | "cancelled"; note: string | null }>();
      handoffs.set(requestId, { sessionId, deferred });
      yield* manager.appendEvent(sessionId, { _tag: "BrowserHandoff", requestId, tabId: tab.id, url: tab.url, reason: text });
      const bot = yield* store.getBot(botId).pipe(Effect.option);
      yield* manager.publish({
        _tag: "Notify",
        botId,
        sessionId,
        title: `${Option.isSome(bot) ? bot.value.name : "Your bot"} needs you in the browser`,
        body: text,
      });
      const answer = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(Duration.millis(Math.min(Math.max(timeoutMs, 30_000), HANDOFF_MAX_MS))),
        Effect.onInterrupt(() => handoffResolved(sessionId, requestId, "expired").pipe(Effect.ignore)),
        Effect.ensuring(Effect.sync(() => handoffs.delete(requestId))),
      );
      if (Option.isNone(answer)) {
        yield* handoffResolved(sessionId, requestId, "expired");
        return yield* new ApolloError({ code: "invalid", message: "the user did not take over the browser in time; tell them what is needed and stop" });
      }
      if (answer.value.outcome === "cancelled") {
        return yield* new ApolloError({
          code: "invalid",
          message: `the user declined to do this in the browser${answer.value.note ? `: ${answer.value.note}` : ""}; do not ask again unless they say so`,
        });
      }
      // The page may have moved on (signed in, redirected): report where it is now.
      const now = core.list(botId).find((t) => t.id === tab.id);
      return { tabId: tab.id, url: now?.url ?? tab.url, title: now?.title ?? tab.title, note: answer.value.note };
    });

  const respondHandoff = (sessionId: SessionId, requestId: string, outcome: "done" | "cancelled", note: string | null) =>
    Effect.gen(function* () {
      const pending = handoffs.get(requestId);
      if (!pending || pending.sessionId !== sessionId) {
        return yield* new ApolloError({ code: "invalid", message: "the agent is no longer waiting (it timed out, or Apollo restarted)" });
      }
      yield* handoffResolved(sessionId, requestId, outcome);
      yield* Deferred.succeed(pending.deferred, { outcome, note: note?.trim() || null });
    });

  return {
    handoff,
    respondHandoff,
    status: Effect.sync(() => core.status()),
    list: (botId?: BotId) => Effect.sync(() => core.list(botId)),
    open: (botId: BotId, sessionId: SessionId, url: string | undefined, newTab: boolean) =>
      attempt(() => core.open(botId, sessionId, url, newTab)),
    navigate: (
      botId: BotId,
      sessionId: SessionId,
      tabId: string | undefined,
      url: string | undefined,
      history: "back" | "forward" | "reload" | undefined,
      timeoutMs: number | undefined,
    ) => attempt(() => core.navigate(botId, sessionId, tabId, url, history, timeoutMs)),
    snapshot: (botId: BotId, sessionId: SessionId, tabId?: string) => attempt(() => core.snapshot(botId, sessionId, tabId)),
    act: (botId: BotId, sessionId: SessionId, tabId: string | undefined, input: ActInput) =>
      attempt(() => core.act(botId, sessionId, tabId, input)),
    evaluate: (botId: BotId, sessionId: SessionId, tabId: string | undefined, expression: string) =>
      attempt(() => core.evaluateForAgent(botId, sessionId, tabId, expression)),
    waitFor: (
      botId: BotId,
      sessionId: SessionId,
      tabId: string | undefined,
      condition: { text?: string | undefined; selector?: string | undefined; urlIncludes?: string | undefined },
      timeoutMs: number,
    ) => attempt(() => core.waitFor(botId, sessionId, tabId, condition, timeoutMs)),
    screenshot: (botId: BotId, sessionId: SessionId, tabId: string | undefined, fullPage: boolean) =>
      attempt(() => core.screenshot(botId, sessionId, tabId, fullPage)),
    tabs: (botId: BotId, sessionId: SessionId) => Effect.sync(() => core.tabsFor(botId, sessionId)),
    renderHtml: (html: string, width: number, appearance: "dark" | "light") =>
      attempt(() => core.renderHtml(html, width, appearance)),
    close: (botId: BotId, sessionId: SessionId, tabId?: string) => attempt(() => core.close(botId, sessionId, tabId)),
    emulate: (botId: BotId, sessionId: SessionId, tabId: string | undefined, input: Parameters<BrowserCore["emulate"]>[3]) =>
      attempt(() => core.emulate(botId, sessionId, tabId, input)),
    setDialogs: (botId: BotId, sessionId: SessionId, tabId: string | undefined, mode: "auto" | "accept" | "dismiss", promptText: string | null) =>
      attempt(async () => core.setDialogs(botId, sessionId, tabId, mode, promptText)),
    startRecording: (botId: BotId, sessionId: SessionId, tabId: string | undefined) =>
      attempt(() => core.startRecording(botId, sessionId, tabId)),
    stopRecording: (botId: BotId, sessionId: SessionId, tabId: string | undefined) =>
      attempt(() => core.stopRecording(botId, sessionId, tabId)),

    // The user's live view.
    openForUser: (botId: BotId, sessionId: SessionId, url: string) => attempt(() => core.openForUser(botId, sessionId, url)),
    navigateForUser: (tabId: string, url: string) => attempt(() => core.navigateForUser(tabId, url)),
    closeForUser: (tabId: string) => attempt(() => core.closeForUser(tabId)),
    input: (tabId: string, input: BrowserInput) => attempt(() => core.userInput(tabId, input)),
    watch: (tabId: string): Stream.Stream<BrowserFrame, ApolloError> =>
      Stream.callback<BrowserFrame, ApolloError>(
        (queue) =>
          Effect.acquireRelease(
            attempt(() => core.watch(tabId, (frame) => void Queue.offerUnsafe(queue, frame))),
            (stop) => Effect.sync(stop),
          ),
        // Only the newest frames matter to a viewer that falls behind.
        { bufferSize: 2, strategy: "sliding" },
      ),
  };
});

export class Browser extends Context.Service<Browser, Effect.Success<typeof make>>()("apollo/Browser") {}

export const layer = Layer.effect(Browser, make);
