import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, open, SCHEMA_VERSION } from "../../../server/src/Database.ts";
import { checkMigratedDatabase, seedOldDatabase, serverUrlFromLog, smokeEnv } from "./smoke-lib.ts";

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
