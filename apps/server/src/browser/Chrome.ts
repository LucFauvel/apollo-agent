import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Finding and launching a Chromium-based browser (Chrome, Edge, Chromium,
 * Brave) for Apollo's built-in browser. Apollo drives it over the DevTools
 * protocol; it does not ship a browser of its own.
 */

const macApps = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "Brave Browser.app/Contents/MacOS/Brave Browser",
  "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

const linuxCommands = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "microsoft-edge-stable",
  "brave-browser",
];

const windowsPaths = (env: NodeJS.ProcessEnv) =>
  [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
    .filter((base): base is string => Boolean(base))
    .flatMap((base) => [
      join(base, "Google", "Chrome", "Application", "chrome.exe"),
      join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(base, "Chromium", "Application", "chrome.exe"),
      join(base, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ]);

const onPath = (command: string, env: NodeJS.ProcessEnv) =>
  (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, command))
    .find((candidate) => existsSync(candidate));

/** The browser to run: `override` if given, else the first one installed. */
export const findBrowser = (override: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null => {
  if (override) return existsSync(override) ? override : null;
  switch (process.platform) {
    case "darwin":
      return (
        ["/Applications", join(homedir(), "Applications")]
          .flatMap((dir) => macApps.map((app) => join(dir, app)))
          .find((candidate) => existsSync(candidate)) ?? null
      );
    case "win32":
      return windowsPaths(env).find((candidate) => existsSync(candidate)) ?? null;
    default:
      return linuxCommands.map((command) => onPath(command, env)).find(Boolean) ?? null;
  }
};

export interface LaunchedBrowser {
  readonly process: ChildProcess;
  /** Browser-level DevTools WebSocket URL. */
  readonly webSocketUrl: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A browser left over from an Apollo that crashed still holds the profile, and a
 * new launch would hand off to it and exit. Its lock names its pid
 * (`SingletonLock` → `host-pid`, macOS and Linux): stop it and clear the locks.
 */
const releaseStaleProfile = async (profileDir: string) => {
  let pid: number | null = null;
  try {
    pid = Number(/-(\d+)$/.exec(readlinkSync(join(profileDir, "SingletonLock")))?.[1]) || null;
  } catch {
    return; // No lock (or Windows, where the OS releases it with the process).
  }
  // Only stop it if it really is a browser on this profile: after a reboot the pid may be anything.
  let command = "";
  try {
    if (pid !== null) command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  } catch {
    // No such process.
  }
  if (pid !== null && pid !== process.pid && command.includes(`--user-data-dir=${profileDir}`)) {
    try {
      process.kill(pid, "SIGKILL");
      await sleep(300);
    } catch {
      // Already gone.
    }
  }
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(join(profileDir, name), { force: true });
};

/**
 * Starts the browser with its own profile in `profileDir` and a DevTools port
 * the OS picks, then reads the port from the `DevToolsActivePort` file.
 */
export const launchBrowser = async (
  executable: string,
  profileDir: string,
  { headless, width, height }: { headless: boolean; width: number; height: number },
): Promise<LaunchedBrowser> => {
  mkdirSync(profileDir, { recursive: true });
  await releaseStaleProfile(profileDir);
  const portFile = join(profileDir, "DevToolsActivePort");
  rmSync(portFile, { force: true });

  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    `--window-size=${width},${height}`,
    ...(headless ? ["--headless=new", "--hide-scrollbars", "--mute-audio"] : []),
    "about:blank",
  ];
  const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`the browser exited while starting: ${stderr.trim().split("\n").slice(-3).join(" ") || "no output"}`);
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").split("\n").map((line) => line.trim());
      if (port && path) return { process: child, webSocketUrl: `ws://127.0.0.1:${port}${path}` };
    }
    await sleep(100);
  }
  child.kill("SIGKILL");
  throw new Error("the browser did not open its DevTools port within 20 seconds");
};

/** Asks the browser to exit, then kills it if it does not. */
export const stopBrowser = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timer);
};
