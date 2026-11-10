import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { type PanelRow, TrayPanel } from "./trayPanel.js";
import { Updater } from "./update/controller.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

/**
 * Where the server and UI live. A packaged app ships a bundled server
 * (scripts/bundle-server.ts) and the built UI as extra resources; development
 * runs the TypeScript sources from the checkout.
 */
const layout = app.isPackaged
  ? {
      serverEntry: join(process.resourcesPath, "server", "server.mjs"),
      webDist: join(process.resourcesPath, "web"),
      trayDir: join(process.resourcesPath, "tray"),
      tailnetAddon: join(process.resourcesPath, "native", "apollo_tailnet.node"),
      appIcon: null,
      cwd: homedir(),
    }
  : {
      serverEntry: join(repoRoot, "apps/server/src/bin.ts"),
      webDist: join(repoRoot, "apps/web/dist"),
      trayDir: join(repoRoot, "apps/desktop/resources/tray"),
      // Built by apps/server/native/tailnet/build.sh.
      tailnetAddon: join(repoRoot, "apps/server/native/tailnet/build/apollo_tailnet.node"),
      // Installers embed the icon; a development run sets it on the window and dock.
      appIcon: join(repoRoot, "apps/desktop/resources/icon.png"),
      cwd: repoRoot,
    };

/**
 * Apps started from a desktop launcher (notably on macOS) get a minimal PATH,
 * which hides `claude` and `codex`. Ask the user's login shell for the real one.
 */
const loginShellPath = (): string | null => {
  if (process.platform === "win32") return null;
  const shell = process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const result = spawnSync(shell, ["-ilc", 'printf "__APOLLO_PATH__%s" "$PATH"'], {
    encoding: "utf8",
    timeout: 5000,
  });
  const match = /__APOLLO_PATH__(.*)$/s.exec(result.stdout ?? "");
  return match?.[1]?.trim() || null;
};

const findOnPath = (command: string, path: string): string | null => {
  const names = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`] : [command];
  for (const dir of path.split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
};

/**
 * Environment for the server. The packaged app does not ship Claude Code's own
 * binary (300+ MB), so it uses the `claude` CLI the user installed, like `codex`.
 */
const providerEnv = (): Record<string, string> => {
  if (!app.isPackaged) return {};
  const path = [loginShellPath(), process.env.PATH].filter(Boolean).join(delimiter);
  const claude = process.env.APOLLO_CLAUDE_BIN ?? findOnPath("claude", path);
  // Windows: `codex` is npm's codex.cmd, which a plain spawn of "codex" does not find.
  const codex = process.env.APOLLO_CODEX_BIN ?? (process.platform === "win32" ? findOnPath("codex", path) : null);
  return { PATH: path, ...(claude ? { APOLLO_CLAUDE_BIN: claude } : {}), ...(codex ? { APOLLO_CODEX_BIN: codex } : {}) };
};

/** Dev: Vite serves the UI and proxies /rpc to this port. Otherwise the server serves the built UI. */
const devUrl = process.env.APOLLO_DEV_URL;
/**
 * Write a PNG of the window to this path once loaded, then quit (for automated checks).
 * `APOLLO_SCREENSHOT_JS` runs in the page first, `APOLLO_SCREENSHOT_DELAY` waits before that.
 */
const screenshotPath = process.env.APOLLO_SCREENSHOT;

let server: ChildProcess | null = null;
let tray: Tray | null = null;
/** Latest status from the server, and whether the tray menu is open right now. */
let trayStatus: DesktopStatus | null = null;
let trayMenuOpen = false;
/** macOS: the panel the menu bar icon opens. */
let trayPanel: TrayPanel | null = null;
let trayMenuStale = false;
/** Set once the user really quits; until then, closing the window hides it to the tray. */
let quitting = false;
/** The in-app updater (src/update/), created once the app is ready. */
let updater: Updater | null = null;

/** The "Check for Updates…" entry, whose label follows the updater's state. */
const updateMenuItem = (): Electron.MenuItemConstructorOptions => ({
  label: updater?.menuLabel() ?? "Check for Updates…",
  enabled: updater?.menuEnabled() ?? false,
  click: () => updater?.menuClicked(),
});

/** macOS: the app menu, with Check for Updates…; the other menus are Electron's defaults. */
const setAppMenu = () => {
  if (process.platform !== "darwin") return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          updateMenuItem(),
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
};

/**
 * Per-launch secret shared only with our own server process. The window opens
 * `/pair#token=…` with it, so the desktop app pairs itself without user action.
 */
const bootstrapToken = randomBytes(32).toString("base64url");

const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port"))));
    });
  });

const waitForHealth = async (url: string, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // A request that reaches the port while the server is still starting can stall.
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Apollo server exited with code ${server.exitCode}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Apollo server did not become healthy in time");
};

/**
 * Starts the Apollo server as a child process. By default it runs on
 * Electron's own Node (`ELECTRON_RUN_AS_NODE`), which supports TypeScript and
 * node:sqlite, so no system Node is needed. `APOLLO_NODE` selects another runtime.
 */
/** The port the server listens on; a restart after a crash reuses it, so the open window reconnects. */
let serverPort: number | null = null;
/** The last notification shown; a new server numbers them from 1 again. */
let noticeCursor = 0;
let restarts: Array<number> = [];

const startServer = async (): Promise<string> => {
  const port = serverPort ?? (devUrl ? Number(process.env.APOLLO_PORT ?? 4317) : await freePort());
  serverPort = port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtime = process.env.APOLLO_NODE ?? process.execPath;
  noticeCursor = 0;
  server = spawn(runtime, [layout.serverEntry], {
    cwd: layout.cwd,
    env: {
      ...process.env,
      ...providerEnv(),
      ...(process.env.APOLLO_NODE ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
      APOLLO_DESKTOP_BOOTSTRAP_TOKEN: bootstrapToken,
      APOLLO_PORT: String(port),
      APOLLO_HOST: "127.0.0.1",
      APOLLO_TAILNET_ADDON: process.env.APOLLO_TAILNET_ADDON ?? layout.tailnetAddon,
      ...(devUrl
        ? { APOLLO_ALLOWED_ORIGINS: new URL(devUrl).origin }
        : { APOLLO_WEB_DIST: layout.webDist }),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const child = server;
  child.once("exit", (code, signal) => {
    if (quitting || server !== child) return;
    // The server died on its own: start it again on the same port. The window's
    // connection retries by itself, so the user only sees a short reconnect.
    console.error(`Apollo server exited (${signal ?? code}); restarting it`);
    server = null;
    restarts = [...restarts.filter((at) => Date.now() - at < 60_000), Date.now()];
    if (restarts.length > 3) {
      console.error("Apollo server keeps exiting; not restarting it again");
      return;
    }
    setTimeout(() => void startServer().catch((error) => console.error("restarting the server failed", error)), 1000);
  });
  await waitForHealth(baseUrl);
  return baseUrl;
};

const stopServer = () => {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  server = null;
};

const createWindow = async (url: string) => {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#09090b",
    title: "Apollo",
    show: !screenshotPath,
    ...(layout.appIcon && process.platform !== "darwin" ? { icon: layout.appIcon } : {}),
    autoHideMenuBar: true,
    // macOS: no title bar; the UI draws its own and leaves room for the traffic lights.
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 16, y: 17 } } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(screenshotPath ? { offscreen: true } : {}),
    },
  });

  // Bots keep working (schedules, workers) with the window closed: hide it to
  // the tray instead, until the user quits from the tray or the app menu.
  if (!screenshotPath) {
    window.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      // The Dock icon stays (with its running dot); clicking it brings the window back.
      window.hide();
    });
  }

  // Links open in the user's browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    // The page asks to be shown (e.g. a notification was clicked while the window was hidden).
    if (target === "apollo-desktop://show") {
      showWindow();
      return { action: "deny" };
    }
    void shell.openExternal(target);
    return { action: "deny" };
  });

  await window.loadURL(url);

  if (screenshotPath) {
    const delay = Number(process.env.APOLLO_SCREENSHOT_DELAY ?? 2500);
    await new Promise((r) => setTimeout(r, delay));
    // Optional page script to reach the state to capture (e.g. click a session).
    if (process.env.APOLLO_SCREENSHOT_JS) {
      await window.webContents.executeJavaScript(process.env.APOLLO_SCREENSHOT_JS);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const image = await window.webContents.capturePage();
    writeFileSync(screenshotPath, image.toPNG());
    app.quit();
  }
};

const showWindow = () => {
  const [window] = BrowserWindow.getAllWindows();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};

/**
 * What `/api/desktop/status` returns. Mirrors `DesktopStatus` in @apollo/contracts
 * (this package compiles to plain JS and does not import workspace sources).
 */
interface DesktopStatus {
  readonly bots: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly paused: boolean;
    readonly working: number;
    readonly needsYou: number;
  }>;
  readonly localModels: {
    readonly server: "stopped" | "starting" | "running" | "error";
    readonly loaded: ReadonlyArray<string>;
    readonly loading: ReadonlyArray<{ readonly model: string; readonly percent: number }>;
    readonly downloads: ReadonlyArray<{ readonly model: string; readonly percent: number }>;
  } | null;
  readonly notifications?: ReadonlyArray<Notice>;
}

interface Notice {
  readonly id: number;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly sessionId: string;
}

/** Shown notifications, kept so they are not garbage-collected before they are clicked. */
const shownNotices = new Set<Notification>();

/**
 * A turn finished, or a bot needs an approval, an answer or a secret: a system
 * notification, unless Apollo's window is in front. Clicking it opens that conversation.
 */
const showNotice = (notice: Notice) => {
  const [window] = BrowserWindow.getAllWindows();
  // (A test from Settings shows anyway: that is where the user is looking.)
  if (notice.kind !== "test" && window && window.isVisible() && window.isFocused()) return;
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: notice.title, body: notice.body });
  shownNotices.add(notification);
  const forget = () => shownNotices.delete(notification);
  notification.on("click", () => {
    forget();
    showWindow();
    if (!notice.sessionId) return;
    void BrowserWindow.getAllWindows()[0]
      ?.webContents.executeJavaScript(`window.apolloOpenSession?.(${JSON.stringify(notice.sessionId)})`)
      .catch(() => undefined);
  });
  notification.on("close", forget);
  notification.show();
};

/** `unsloth/Qwen3-4B-GGUF:Q4_K_M` → `Qwen3-4B Q4_K_M`. */
const modelName = (id: string) => {
  const [repo = id, quant] = id.split(/:(?=[^/]+$)/);
  const name = repo.split("/").pop()!.replace(/[-_.]?GGUF$/i, "");
  return quant ? `${name} ${quant}` : name;
};

const SERVER_LABEL: Record<NonNullable<DesktopStatus["localModels"]>["server"], string> = {
  running: "Running",
  starting: "Starting…",
  stopped: "Stopped",
  error: "Error",
};

const botLine = (bot: DesktopStatus["bots"][number]) => {
  if (bot.needsYou > 0) return `◉  ${bot.name} — needs you`;
  if (bot.working > 0) return `●  ${bot.name} — working${bot.working > 1 ? ` (${bot.working} sessions)` : ""}`;
  if (bot.paused) return `‖  ${bot.name} — paused`;
  return `○  ${bot.name} — idle`;
};

/** The tray menu: bots and what they are doing, the local model server, then app actions. */
const trayMenu = (status: DesktopStatus | null) => {
  const items: Array<Electron.MenuItemConstructorOptions> = [];
  if (status) {
    items.push({ label: "Bots", enabled: false });
    if (status.bots.length === 0) items.push({ label: "No bots yet", enabled: false });
    for (const bot of status.bots) items.push({ label: botLine(bot), click: showWindow });
    if (status.localModels) {
      const { server, loaded, downloads } = status.localModels;
      items.push({ type: "separator" }, { label: "Local models", enabled: false });
      items.push({ label: `llama-server — ${SERVER_LABEL[server]}`, enabled: false });
      for (const model of loaded) items.push({ label: `   ${modelName(model)} loaded`, enabled: false });
      for (const l of status.localModels.loading ?? []) items.push({ label: `   Loading ${modelName(l.model)} — ${l.percent}%`, enabled: false });
      for (const d of downloads) items.push({ label: `   Downloading ${modelName(d.model)} — ${d.percent}%`, enabled: false });
    }
    items.push({ type: "separator" });
  }
  items.push({ label: "Open Apollo", click: showWindow }, updateMenuItem(), { type: "separator" }, { label: "Quit Apollo", role: "quit" });
  return Menu.buildFromTemplate(items);
};

/** The same content as the tray menu, as rows of the macOS panel. */
const panelRows = (status: DesktopStatus | null): Array<PanelRow> => {
  const rows: Array<PanelRow> = [];
  if (status) {
    rows.push({ kind: "heading", text: "Bots" });
    if (status.bots.length === 0) rows.push({ kind: "item", text: "No bots yet", dot: "off" });
    for (const bot of status.bots) {
      const [dot, detail]: [NonNullable<Extract<PanelRow, { kind: "item" }>["dot"]>, string] =
        bot.needsYou > 0
          ? ["needs", "Needs you"]
          : bot.working > 0
            ? ["working", bot.working > 1 ? `Working · ${bot.working}` : "Working"]
            : bot.paused
              ? ["paused", "Paused"]
              : ["idle", "Idle"];
      rows.push({ kind: "item", text: bot.name, detail, dot, action: `bot:${bot.id}` });
    }
    if (status.localModels) {
      const { server, loaded, downloads } = status.localModels;
      rows.push({ kind: "separator" }, { kind: "heading", text: "Local models" });
      const dot = server === "running" ? "ok" : server === "error" ? "warn" : server === "starting" ? "warn" : "off";
      rows.push({ kind: "item", text: "llama-server", detail: SERVER_LABEL[server], dot });
      for (const model of loaded) rows.push({ kind: "item", text: modelName(model), detail: "Loaded" });
      for (const l of status.localModels.loading ?? []) {
        rows.push({ kind: "item", text: modelName(l.model), detail: `Loading ${l.percent}%`, progress: l.percent });
      }
      for (const d of downloads) {
        rows.push({ kind: "item", text: modelName(d.model), detail: `Downloading ${d.percent}%`, progress: d.percent });
      }
    }
    rows.push({ kind: "separator" });
  }
  rows.push(
    { kind: "item", text: "Open Apollo", action: "open" },
    updater?.menuEnabled() === false ? { kind: "item", text: updater.menuLabel() } : { kind: "item", text: updater?.menuLabel() ?? "Check for Updates…", action: "update" },
    { kind: "item", text: "Quit Apollo", action: "quit" },
  );
  return rows;
};

const traySummary = (status: DesktopStatus) => {
  const working = status.bots.filter((b) => b.working > 0).length;
  const waiting = status.bots.filter((b) => b.needsYou > 0).length;
  const parts = [
    waiting ? `${waiting} waiting for you` : null,
    working ? `${working} working` : null,
    status.localModels ? `llama-server ${SERVER_LABEL[status.localModels.server].toLowerCase()}` : null,
  ].filter(Boolean);
  return { working, waiting, tooltip: parts.length ? `Apollo — ${parts.join(", ")}` : "Apollo" };
};

/** Menu bar (macOS) or system tray icon: status at a glance, open the window, or quit for real. */
const createTray = () => {
  const mac = process.platform === "darwin";
  // macOS tints a template image to match the menu bar; elsewhere use the color icon.
  const icon = nativeImage.createFromPath(join(layout.trayDir, mac ? "trayTemplate.png" : "tray.png"));
  if (mac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Apollo");
  if (mac) {
    // A native menu does not open on another Space (desktop or full-screen app) while
    // Apollo's window is elsewhere; a panel shown on every Space does (see TrayPanel).
    trayPanel = new TrayPanel(tray, (action) => (action === "quit" ? app.quit() : action === "update" ? updater?.menuClicked() : showWindow()));
    trayPanel.setRows(panelRows(trayStatus));
    tray.on("click", () => trayPanel?.toggle());
    tray.on("right-click", () => trayPanel?.toggle());
  } else {
    refreshTrayMenu();
  }
  // Windows: left click opens the window, right click shows the menu.
  if (process.platform === "win32") tray.on("click", showWindow);
};

/** A menu from the latest status that tracks whether it is open. */
const buildTrayMenu = () => {
  const menu = trayMenu(trayStatus);
  menu.on("menu-will-show", () => {
    trayMenuOpen = true;
  });
  menu.on("menu-will-close", () => {
    trayMenuOpen = false;
    if (trayMenuStale) setTimeout(refreshTrayMenu, 100);
  });
  return menu;
};


/**
 * Windows and Linux: attaches a menu built from the latest status. Replacing the menu while it is open
 * closes it, so changes that arrive meanwhile wait until it closes.
 */
const refreshTrayMenu = () => {
  if (!tray || process.platform === "darwin") return;
  if (trayMenuOpen) {
    trayMenuStale = true;
    return;
  }
  trayMenuStale = false;
  const menu = buildTrayMenu();
  tray.setContextMenu(menu);
};

/** Polls the server for bot activity and updates the tray; rebuilds the menu only on change. */
const followStatus = (serverUrl: string) => {
  let last = "";
  const poll = async () => {
    try {
      const response = await fetch(`${serverUrl}/api/desktop/status?after=${noticeCursor}`, {
        headers: { authorization: `Bearer ${bootstrapToken}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return;
      const { notifications = [], ...status } = (await response.json()) as DesktopStatus;
      for (const notice of notifications) {
        if (notice.id <= noticeCursor) continue;
        noticeCursor = notice.id;
        showNotice(notice);
      }
      const key = JSON.stringify(status);
      if (key === last || !tray) return;
      last = key;
      trayStatus = status;
      const { working, waiting, tooltip } = traySummary(status);
      refreshTrayMenu();
      trayPanel?.setRows(panelRows(status));
      tray.setToolTip(tooltip);
      // macOS shows a count next to the icon while bots work or wait for you.
      if (process.platform === "darwin") tray.setTitle(waiting ? ` ${waiting}!` : working ? ` ${working}` : "");
    } catch {
      // The server is starting or stopping; try again on the next tick.
    }
  };
  void poll();
  setInterval(() => void poll(), 2000).unref();
};

// A separate Chromium profile, and with it a separate single-instance lock: the release smoke
// test (scripts/release/smoke.ts) launches a packaged copy next to a running Apollo.
if (process.env.APOLLO_USER_DATA_DIR) app.setPath("userData", resolve(process.env.APOLLO_USER_DATA_DIR));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  // macOS: clicking the dock icon brings the hidden window back.
  app.on("activate", showWindow);

  app.whenReady().then(async () => {
    try {
      if (layout.appIcon && process.platform === "darwin") app.dock?.setIcon(layout.appIcon);
      if (!screenshotPath) {
        // The updater never throws from here (it falls back to inert); belt and braces, since
        // anything thrown in this block quits the app.
        try {
          updater = new Updater({
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            appPath: app.getAppPath(),
            userData: app.getPath("userData"),
            dataDir: resolve(process.env.APOLLO_DATA_DIR ?? join(homedir(), ".apollo")),
            onChange: () => {
              setAppMenu();
              refreshTrayMenu();
              trayPanel?.setRows(panelRows(trayStatus));
            },
            quit: () => {
              quitting = true;
              app.quit();
            },
            busyBots: () => trayStatus?.bots.reduce((n, b) => n + (b.working > 0 ? 1 : 0), 0) ?? 0,
          });
        } catch (error) {
          console.error("updater disabled:", error);
          updater = null;
        }
        setAppMenu();
      }
      if (!screenshotPath) createTray();
      const serverUrl = await startServer();
      if (tray) followStatus(serverUrl);
      const uiUrl = (devUrl ?? serverUrl).replace(/\/+$/, "");
      await createWindow(`${uiUrl}/pair#token=${bootstrapToken}&label=Apollo%20Desktop`);
      updater?.start();
    } catch (error) {
      console.error(error);
      stopServer();
      app.exit(1);
    }
  });

  // The window only hides (see createWindow); this runs in screenshot mode.
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    quitting = true;
    stopServer();
  });
  process.on("exit", stopServer);
}
