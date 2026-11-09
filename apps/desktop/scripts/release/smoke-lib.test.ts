import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, open, SCHEMA_VERSION } from "../../../server/src/Database.ts";
import {
  checkMigratedDatabase,
  descendantsOf,
  nsisInstallInvocation,
  parsePs,
  parseWinProcesses,
  portAccepts,
  processesUnder,
  runSilentInstall,
  seedOldDatabase,
  serverUrlFromLog,
  smokeEnv,
} from "./smoke-lib.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "smoke-lib-")), "apollo.db");
const versionOf = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
};

describe("seedOldDatabase + the server's own migrations", () => {
  it.each([1, Math.max(1, SCHEMA_VERSION - 1)])("seeded at schema %i, open() migrates it and keeps the seed", (version) => {
    const path = fresh();
    seedOldDatabase(path, MIGRATIONS, version);
    expect(versionOf(path)).toBe(version);
    expect(checkMigratedDatabase(path, version)).toEqual([]);
    open(path).close();
    expect(checkMigratedDatabase(path, SCHEMA_VERSION)).toEqual([]);
  });

  it("reports a database that was not migrated", () => {
    const path = fresh();
    seedOldDatabase(path, MIGRATIONS, 1);
    expect(checkMigratedDatabase(path, SCHEMA_VERSION)).toEqual(SCHEMA_VERSION === 1 ? [] : [`schema version 1, expected ${SCHEMA_VERSION}`]);
  });

  it("reports lost rows", () => {
    const path = fresh();
    seedOldDatabase(path, MIGRATIONS, 1);
    const db = new DatabaseSync(path);
    db.exec("pragma foreign_keys = on; delete from memories; delete from bots;");
    db.close();
    const problems = checkMigratedDatabase(path, 1);
    expect(problems).toContain("the seeded bot is gone");
    expect(problems).toContain("the seeded memory is gone");
    expect(problems).toContain("the seeded skill is gone");
  });

  it("refuses versions outside the migrations", () => {
    expect(() => seedOldDatabase(fresh(), MIGRATIONS, 0)).toThrow();
    expect(() => seedOldDatabase(fresh(), MIGRATIONS, MIGRATIONS.length + 1)).toThrow();
  });
});

describe("serverUrlFromLog", () => {
  it("finds the loopback URL the server logs", () => {
    expect(serverUrlFromLog("noise\n[22:55:05.311] INFO (#1): Listening on http://127.0.0.1:61003\nmore")).toBe("http://127.0.0.1:61003");
    expect(serverUrlFromLog("Listening on http://localhost:4317")).toBe("http://localhost:4317");
  });
  it("ignores a missing line and non-loopback hosts", () => {
    expect(serverUrlFromLog("starting…")).toBeNull();
    expect(serverUrlFromLog("Listening on http://0.0.0.0:4317")).toBeNull();
    expect(serverUrlFromLog("Listening on http://100.64.0.1:4317")).toBeNull();
  });
});

describe("smokeEnv", () => {
  const dirs = { home: "/t/home", dataDir: "/t/data", userDataDir: "/t/electron", screenshot: "/t/w.png", screenshotDelayMs: 6000 };
  const fakeLaunchEnv = (env: NodeJS.ProcessEnv) => ({ HOME: env.HOME ?? "", PATH: "/usr/bin:/bin" });
  const leaky = { ELECTRON_RUN_AS_NODE: "1", APOLLO_DATA_DIR: "/real", APOLLO_PORT: "4317", NODE_OPTIONS: "--inspect", HOME: "/Users/luc" };

  it("macOS: the install:app allowlist, redirected into the throwaway dir", () => {
    const env = smokeEnv("darwin", { ...leaky, SECRET_TOKEN: "x" }, fakeLaunchEnv, dirs);
    expect(env).toEqual({
      HOME: "/t/home",
      PATH: "/usr/bin:/bin",
      APOLLO_DATA_DIR: "/t/data",
      APOLLO_USER_DATA_DIR: "/t/electron",
      APOLLO_SCREENSHOT: "/t/w.png",
      APOLLO_SCREENSHOT_DELAY: "6000",
    });
  });

  it("Windows: keeps the system variables, drops redirections whatever their case, isolates the profile", () => {
    const env = smokeEnv(
      "win32",
      { ...leaky, electron_run_as_node: "1", Apollo_Port: "1", SystemRoot: "C:\\Windows", Path: "C:\\Windows\\System32", UserProfile: "C:\\Users\\luc", TEMP: "C:\\Temp" },
      fakeLaunchEnv,
      dirs,
    );
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.Path).toBe("C:\\Windows\\System32");
    expect(env.TEMP).toBe("C:\\Temp");
    expect(env.USERPROFILE).toBe("/t/home");
    expect(env.UserProfile).toBeUndefined();
    expect(env.HOME).toBe("/t/home");
    expect(env.APOLLO_DATA_DIR).toBe("/t/data");
    for (const k of ["ELECTRON_RUN_AS_NODE", "electron_run_as_node", "APOLLO_PORT", "Apollo_Port", "NODE_OPTIONS"]) expect(env[k]).toBeUndefined();
  });
});

describe("leftover detection (review P2-2)", () => {
  it("parses ps and Windows CIM process lists", () => {
    expect(parsePs("  1     0 /sbin/launchd\n 4242  4200 /private/var/x/Apollo.app/Contents/MacOS/apollo --flag\n")).toEqual([
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 4242, ppid: 4200, command: "/private/var/x/Apollo.app/Contents/MacOS/apollo --flag" },
    ]);
    const json = JSON.stringify([
      { ProcessId: 10, ParentProcessId: 4, ExecutablePath: "C:\\Temp\\installed\\apollo.exe", CommandLine: '"C:\\Temp\\installed\\apollo.exe" --type=gpu' },
      { ProcessId: 11, ParentProcessId: 10, ExecutablePath: null, CommandLine: null },
    ]);
    expect(parseWinProcesses(json)).toEqual([
      { pid: 10, ppid: 4, command: 'C:\\Temp\\installed\\apollo.exe "C:\\Temp\\installed\\apollo.exe" --type=gpu' },
      { pid: 11, ppid: 10, command: "" },
    ]);
    expect(parseWinProcesses(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, CommandLine: "x" }))).toEqual([{ pid: 5, ppid: 1, command: "x" }]);
    expect(parseWinProcesses("")).toEqual([]);
  });

  it("follows the whole tree below the app", () => {
    const procs = [
      { pid: 100, ppid: 1, command: "app" },
      { pid: 101, ppid: 100, command: "server" },
      { pid: 102, ppid: 101, command: "grandchild" },
      { pid: 200, ppid: 1, command: "unrelated" },
    ];
    expect([...descendantsOf(procs, 100)].sort()).toEqual([101, 102]);
    expect(descendantsOf(procs, 200).size).toBe(0);
  });

  it("matches processes running from the app directory, whatever the case or /private prefix", () => {
    const mac = parsePs(" 7 1 /private/var/folders/T/apollo-smoke-x/unpacked/apollo.app/Contents/MacOS/apollo\n 8 1 /usr/bin/other /var/folders/T/apollo-smoke-x/unpacked/Apollo.app.bak\n");
    expect(processesUnder(mac, ["/var/folders/T/apollo-smoke-x/unpacked/Apollo.app"], "darwin").map((p) => p.pid)).toEqual([7]);
    const win = [
      { pid: 9, ppid: 1, command: "c:\\temp\\INSTALLED\\resources\\..\\apollo.exe" },
      { pid: 10, ppid: 1, command: "C:\\temp\\installed-other\\x.exe" },
    ];
    expect(processesUnder(win, ["C:/Temp/installed"], "win32").map((p) => p.pid)).toEqual([9]);
    expect(processesUnder(win, ["C:\\Temp\\installed"], "win32", new Set([9]))).toEqual([]);
  });

  it("sees a listener that answers 503 as still there, and a closed port as gone", async () => {
    const server = createServer((_, res) => {
      res.writeHead(503).end(JSON.stringify({ ok: false }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    expect(await portAccepts(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await portAccepts(port)).toBe(false);
  });
});

describe("silent NSIS install (review P2-3)", () => {
  // Legal Windows paths full of cmd.exe metacharacters, spaces included.
  const installer = "C:\\Down&loads\\a^b %PATH% (x)\\Apollo-1.2.3-win-x64-unsigned-setup.exe";
  const dir = "C:\\Temp\\ci&whoami&rem\\apollo smoke ^%USERNAME%!|<>\\installed";

  it("starts the installer directly, the paths verbatim and never through a shell", () => {
    const calls: Array<{ file: string; args: ReadonlyArray<string>; options: Record<string, unknown> }> = [];
    runSilentInstall((file, args, options) => calls.push({ file, args, options }), installer, dir);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.file).toBe(installer);
    expect(call.args).toEqual(["/S", `/D=${dir}`]);
    expect(call.options.shell).toBe(false);
    expect(call.options.windowsVerbatimArguments).toBe(true);
    // argv[0] quoted by hand (verbatim mode quotes nothing); /D= stays last and unquoted for NSIS.
    expect(call.options.argv0).toBe(`"${installer}"`);
    const commandLine = [call.options.argv0, ...call.args].join(" ");
    expect(commandLine).toBe(`"${installer}" /S /D=${dir}`);
    expect(commandLine.endsWith(`/D=${dir}`)).toBe(true);
  });

  it.each([
    ["a quote in the directory", installer, 'C:\\Temp\\a"b\\installed'],
    ["a newline in the directory", installer, "C:\\Temp\\a\nb"],
    ["a quote in the installer path", 'C:\\x"y\\setup.exe', dir],
    ["a relative directory", installer, "installed"],
    ["a relative installer", "setup.exe", dir],
  ])("refuses %s", (_, inst, target) => {
    expect(() => nsisInstallInvocation(inst, target)).toThrow();
  });
});
