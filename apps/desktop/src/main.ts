import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, shell } from "electron";

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
      cwd: homedir(),
    }
  : {
      serverEntry: join(repoRoot, "apps/server/src/bin.ts"),
      webDist: join(repoRoot, "apps/web/dist"),
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
  return { PATH: path, ...(claude ? { APOLLO_CLAUDE_BIN: claude } : {}) };
};

/** Dev: Vite serves the UI and proxies /rpc to this port. Otherwise the server serves the built UI. */
const devUrl = process.env.APOLLO_DEV_URL;
/**
 * Write a PNG of the window to this path once loaded, then quit (for automated checks).
 * `APOLLO_SCREENSHOT_JS` runs in the page first, `APOLLO_SCREENSHOT_DELAY` waits before that.
 */
const screenshotPath = process.env.APOLLO_SCREENSHOT;

let server: ChildProcess | null = null;

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
const startServer = async (): Promise<string> => {
  const port = devUrl ? Number(process.env.APOLLO_PORT ?? 4317) : await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtime = process.env.APOLLO_NODE ?? process.execPath;
  server = spawn(runtime, [layout.serverEntry], {
    cwd: layout.cwd,
    env: {
      ...process.env,
      ...providerEnv(),
      ...(process.env.APOLLO_NODE ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
      APOLLO_DESKTOP_BOOTSTRAP_TOKEN: bootstrapToken,
      APOLLO_PORT: String(port),
      APOLLO_HOST: "127.0.0.1",
      ...(devUrl
        ? { APOLLO_ALLOWED_ORIGINS: new URL(devUrl).origin }
        : { APOLLO_WEB_DIST: layout.webDist }),
    },
    stdio: ["ignore", "inherit", "inherit"],
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
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(screenshotPath ? { offscreen: true } : {}),
    },
  });

  // Links open in the user's browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const serverUrl = await startServer();
      const uiUrl = (devUrl ?? serverUrl).replace(/\/+$/, "");
      await createWindow(`${uiUrl}/pair#token=${bootstrapToken}&label=Apollo%20Desktop`);
    } catch (error) {
      console.error(error);
      stopServer();
      app.exit(1);
    }
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", stopServer);
  process.on("exit", stopServer);
}
