import { ApolloError, BrowserTab } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { Browser, VIEWPORT_PRESETS } from "../browser/Browser.ts";
import { SessionManager } from "../SessionManager.ts";
import { Secrets } from "../secrets/Secrets.ts";
import { McpCaller } from "./Caller.ts";

/**
 * Apollo's built-in browser, for agents: a real Chromium the user can watch
 * live in the UI. Pages are read as text outlines with element refs, then
 * driven by ref.
 */

const shared = {
  failure: ApolloError,
  failureMode: "return" as const,
  dependencies: [McpCaller],
};

const tabId = Schema.optional(Schema.String).annotate({
  description: "Tab to use. Defaults to the tab this session used last.",
});

const Page = Schema.Struct({ tabId: Schema.String, url: Schema.String, title: Schema.String });

const Open = Tool.make("apollo_browser_open", {
  ...shared,
  description: [
    "Open a page in Apollo's built-in browser (a real Chromium the user can watch live).",
    "Reuses this session's tab unless `newTab` is true. `url` can be a full URL, a bare host (https),",
    "or a local dev server like `localhost:5173` (http). Then read it with apollo_browser_snapshot.",
  ].join(" "),
  parameters: Schema.Struct({
    url: Schema.optional(Schema.String),
    newTab: Schema.optional(Schema.Boolean),
  }),
  success: Page,
}).annotate(Tool.OpenWorld, true);

const Navigate = Tool.make("apollo_browser_navigate", {
  ...shared,
  description: "Go to `url` in a tab, or move through its `history` (back, forward, reload). Waits for the page to load.",
  parameters: Schema.Struct({
    url: Schema.optional(Schema.String),
    history: Schema.optional(Schema.Literals(["back", "forward", "reload"])),
    tabId,
    timeoutMs: Schema.optional(Schema.Number),
  }),
  success: Page,
}).annotate(Tool.OpenWorld, true);

const Snapshot = Tool.make("apollo_browser_snapshot", {
  ...shared,
  description: [
    "Read the page as an indented text outline: headings, text, landmarks, and every interactive element",
    'with a ref, like `- button "Sign in" [ref=e12]`. Pass a ref to apollo_browser_act. Refs are replaced by',
    "each snapshot and by navigation. `log` lists console errors, page errors and dialogs since the last call.",
  ].join(" "),
  parameters: Schema.Struct({ tabId }),
  success: Schema.Struct({
    tabId: Schema.String,
    url: Schema.String,
    title: Schema.String,
    loading: Schema.Boolean,
    content: Schema.String,
    truncated: Schema.Boolean,
    log: Schema.Array(Schema.String),
  }),
}).annotate(Tool.Readonly, true);

const Act = Tool.make("apollo_browser_act", {
  ...shared,
  description: [
    "Act on the page. Target an element with `ref` from apollo_browser_snapshot (or a CSS `selector`).",
    "click: optional `button`, `clickCount` 1-3. hover: moves the mouse over it.",
    "type: types literal `text` into the element (`clear: true` replaces its content; `submit: true` presses Enter after);",
    "for passwords and keys pass `secretRef` from apollo_request_secret instead of `text`, so the value never reaches you.",
    "press: one `key` (Enter, Tab, Escape, Backspace, ArrowDown, a character…) with optional `modifiers`, to the focused element.",
    "select: `values` (by value or label) in a native <select>; for custom dropdowns click to open, then click the option.",
    "scroll: the page, or the element given; `deltaY` > 0 scrolls down (default one screen).",
    "Take a new snapshot afterwards to see the result.",
  ].join(" "),
  parameters: Schema.Struct({
    action: Schema.Literals(["click", "type", "press", "hover", "select", "scroll"]),
    ref: Schema.optional(Schema.String),
    selector: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    secretRef: Schema.optional(Schema.String),
    clear: Schema.optional(Schema.Boolean),
    submit: Schema.optional(Schema.Boolean),
    key: Schema.optional(Schema.String),
    modifiers: Schema.optional(Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]))),
    values: Schema.optional(Schema.Array(Schema.String)),
    button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
    clickCount: Schema.optional(Schema.Number),
    deltaX: Schema.optional(Schema.Number),
    deltaY: Schema.optional(Schema.Number),
    tabId,
  }),
  success: Schema.Struct({
    tabId: Schema.String,
    url: Schema.String,
    title: Schema.String,
    navigated: Schema.Boolean,
    note: Schema.NullOr(Schema.String),
    log: Schema.Array(Schema.String),
  }),
}).annotate(Tool.OpenWorld, true);

const Evaluate = Tool.make("apollo_browser_evaluate", {
  ...shared,
  description:
    "Run JavaScript in the page and return its value as text (JSON for objects, up to 64 KB). `await` works at the top level. It can change the page. Prefer snapshot and act for ordinary interaction.",
  parameters: Schema.Struct({ expression: Schema.String, tabId }),
  success: Schema.Struct({ value: Schema.String }),
}).annotate(Tool.OpenWorld, true);

const WaitFor = Tool.make("apollo_browser_wait_for", {
  ...shared,
  description:
    "Wait until the page shows `text`, has a visible element matching `selector`, and/or its URL contains `urlIncludes` (all given conditions). Returns `matched: false` on timeout (default 15 s, at most 60 s).",
  parameters: Schema.Struct({
    text: Schema.optional(Schema.String),
    selector: Schema.optional(Schema.String),
    urlIncludes: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Number),
    tabId,
  }),
  success: Schema.Struct({ matched: Schema.Boolean, tabId: Schema.String, url: Schema.String, title: Schema.String }),
}).annotate(Tool.Readonly, true);

const Screenshot = Tool.make("apollo_browser_screenshot", {
  ...shared,
  description:
    "Save a PNG of the visible page (or the whole page with `fullPage`) and return its path. To look at it, open the path with your image-viewing tool (Claude Code: Read; Codex: view_image). Use it for visual checks; snapshot is cheaper for reading content.",
  parameters: Schema.Struct({ fullPage: Schema.optional(Schema.Boolean), tabId }),
  success: Schema.Struct({ path: Schema.String, tabId: Schema.String, url: Schema.String, bytes: Schema.Number }),
}).annotate(Tool.Readonly, true);

const Tabs = Tool.make("apollo_browser_tabs", {
  ...shared,
  description: "List this bot's open browser tabs, and which one this session uses by default.",
  success: Schema.Struct({ tabs: Schema.Array(BrowserTab), current: Schema.NullOr(Schema.String) }),
}).annotate(Tool.Readonly, true);

const Close = Tool.make("apollo_browser_close", {
  ...shared,
  description: "Close a browser tab when you are done with it.",
  parameters: Schema.Struct({ tabId }),
  success: Schema.Struct({}),
});

const Viewport = Tool.make("apollo_browser_viewport", {
  ...shared,
  description: [
    "Change a tab's viewport and colour scheme to check responsive or themed UIs: `preset` phone (390×844, touch),",
    "tablet (820×1180) or desktop (1280×800), or an explicit width/height; `colorScheme` light or dark sets",
    "prefers-color-scheme. Snapshot or screenshot again afterwards.",
  ].join(" "),
  parameters: Schema.Struct({
    preset: Schema.optional(Schema.Literals(["phone", "tablet", "desktop"])),
    width: Schema.optional(Schema.Number),
    height: Schema.optional(Schema.Number),
    colorScheme: Schema.optional(Schema.Literals(["light", "dark", "no-preference"])),
    tabId,
  }),
  success: Schema.Struct({ tabId: Schema.String, width: Schema.Number, height: Schema.Number }),
});

const Dialogs = Tool.make("apollo_browser_dialogs", {
  ...shared,
  description: [
    "Choose how the tab answers JavaScript dialogs (alert, confirm, prompt) from now on. Default `auto`: accept",
    "alerts and confirms, dismiss prompts. `accept` or `dismiss` answers all of them; `promptText` is what prompts",
    "receive when accepted. What each dialog said shows up in the next snapshot.",
  ].join(" "),
  parameters: Schema.Struct({
    mode: Schema.Literals(["auto", "accept", "dismiss"]),
    promptText: Schema.optional(Schema.String),
    tabId,
  }),
  success: Schema.Struct({ tabId: Schema.String, mode: Schema.String, promptText: Schema.NullOr(Schema.String) }),
});

const RecordStart = Tool.make("apollo_browser_record_start", {
  ...shared,
  description:
    "Start recording a tab (four frames a second, up to 5 minutes) to show the user a flow you drive, e.g. a feature working end to end. Stop with apollo_browser_record_stop.",
  parameters: Schema.Struct({ tabId }),
  success: Schema.Struct({ tabId: Schema.String, recordingId: Schema.String }),
});

const RecordStop = Tool.make("apollo_browser_record_stop", {
  ...shared,
  description:
    "Stop recording a tab. With `show` (default true) the recording appears in the conversation as a playable clip titled `title`.",
  parameters: Schema.Struct({ title: Schema.optional(Schema.String), show: Schema.optional(Schema.Boolean), tabId }),
  success: Schema.Struct({ recordingId: Schema.String, frames: Schema.Number, seconds: Schema.Number, dir: Schema.String, shown: Schema.Boolean }),
});

const Handoff = Tool.make("apollo_browser_handoff", {
  ...shared,
  description: [
    "Hand the browser to the user and wait until they are done, for what only they can do: a CAPTCHA, a 2FA code,",
    "a \"confirm it's you\" prompt, a sign-in with credentials you were not given, a payment confirmation.",
    "They get a notification and see this tab live, on desktop or phone. `reason` says exactly what to do",
    "(\"Sign in to GitHub; I'll continue once you're on the dashboard\"). Returns where the page is now and any",
    "note they left: snapshot it before going on. For passwords you can type yourself, use apollo_request_secret instead.",
  ].join(" "),
  parameters: Schema.Struct({
    reason: Schema.String,
    tabId,
    timeoutMs: Schema.optional(Schema.Number).annotate({ description: "How long to wait, up to 30 minutes (default 15)." }),
  }),
  success: Schema.Struct({ tabId: Schema.String, url: Schema.String, title: Schema.String, note: Schema.NullOr(Schema.String) }),
}).annotate(Tool.OpenWorld, true);

export const BrowserToolkit = Toolkit.make(
  Handoff,
  Open,
  Navigate,
  Snapshot,
  Act,
  Evaluate,
  WaitFor,
  Screenshot,
  Tabs,
  Close,
  Viewport,
  Dialogs,
  RecordStart,
  RecordStop,
);

export const handlers = BrowserToolkit.toLayer(
  Effect.gen(function* () {
    const browser = yield* Browser;
    const secrets = yield* Secrets;
    const manager = yield* SessionManager;
    return {
      apollo_browser_handoff: ({ reason, tabId, timeoutMs }) =>
        Effect.flatMap(McpCaller, (c) => browser.handoff(c.botId, c.sessionId, tabId, reason, timeoutMs ?? 15 * 60_000)),
      apollo_browser_viewport: ({ preset, width, height, colorScheme, tabId }) =>
        Effect.flatMap(McpCaller, (c) => {
          const size = preset ? VIEWPORT_PRESETS[preset] : { width, height, mobile: undefined };
          return browser.emulate(c.botId, c.sessionId, tabId, { ...size, colorScheme });
        }),
      apollo_browser_dialogs: ({ mode, promptText, tabId }) =>
        Effect.flatMap(McpCaller, (c) => browser.setDialogs(c.botId, c.sessionId, tabId, mode, promptText ?? null)),
      apollo_browser_record_start: ({ tabId }) =>
        Effect.flatMap(McpCaller, (c) => browser.startRecording(c.botId, c.sessionId, tabId)),
      apollo_browser_record_stop: ({ title, show, tabId }) =>
        Effect.gen(function* () {
          const c = yield* McpCaller;
          const result = yield* browser.stopRecording(c.botId, c.sessionId, tabId);
          const shown = (show ?? true) && result.frames > 0;
          if (shown) {
            yield* manager.appendEvent(c.sessionId, {
              _tag: "Recording",
              recordingId: result.recordingId,
              title: title?.trim() || result.url,
              frames: result.frames,
              width: result.width,
              height: result.height,
              durationMs: result.durationMs,
            });
          }
          return {
            recordingId: result.recordingId,
            frames: result.frames,
            seconds: Math.round(result.durationMs / 1000),
            dir: result.dir,
            shown,
          };
        }),
      apollo_browser_open: ({ url, newTab }) =>
        Effect.flatMap(McpCaller, (c) => browser.open(c.botId, c.sessionId, url, newTab ?? false)),
      apollo_browser_navigate: ({ url, history, tabId, timeoutMs }) =>
        Effect.flatMap(McpCaller, (c) =>
          browser.navigate(c.botId, c.sessionId, tabId, url, history, Math.min(Math.max(timeoutMs ?? 20_000, 1000), 60_000)),
        ),
      apollo_browser_snapshot: ({ tabId }) => Effect.flatMap(McpCaller, (c) => browser.snapshot(c.botId, c.sessionId, tabId)),
      apollo_browser_act: ({ tabId, secretRef, ...input }) =>
        Effect.gen(function* () {
          const c = yield* McpCaller;
          if (secretRef && input.action !== "type") {
            return yield* new ApolloError({ code: "invalid", message: "`secretRef` only works with action `type`" });
          }
          // The secret is typed into the page; it is not echoed back in the result.
          const text = secretRef ? yield* secrets.take(c.botId, secretRef) : input.text;
          return yield* browser.act(c.botId, c.sessionId, tabId, { ...input, text });
        }),
      apollo_browser_evaluate: ({ expression, tabId }) =>
        Effect.flatMap(McpCaller, (c) => browser.evaluate(c.botId, c.sessionId, tabId, expression)),
      apollo_browser_wait_for: ({ text, selector, urlIncludes, timeoutMs, tabId }) =>
        Effect.flatMap(McpCaller, (c) =>
          browser.waitFor(
            c.botId,
            c.sessionId,
            tabId,
            { text, selector, urlIncludes },
            Math.min(Math.max(timeoutMs ?? 15_000, 500), 60_000),
          ),
        ),
      apollo_browser_screenshot: ({ fullPage, tabId }) =>
        Effect.flatMap(McpCaller, (c) => browser.screenshot(c.botId, c.sessionId, tabId, fullPage ?? false)),
      apollo_browser_tabs: () => Effect.flatMap(McpCaller, (c) => browser.tabs(c.botId, c.sessionId)),
      apollo_browser_close: ({ tabId }) =>
        Effect.flatMap(McpCaller, (c) => browser.close(c.botId, c.sessionId, tabId)).pipe(Effect.as({})),
    };
  }),
);
