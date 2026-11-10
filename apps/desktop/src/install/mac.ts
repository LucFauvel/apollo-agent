/**
 * The real macOS effects the install engine needs (process list, the installer lock's liveness
 * check, busy sessions, /health of the installed app), shared by scripts/install-app.ts and the
 * in-app updater's helper (src/update/helper.ts). Both take the same lock and marker, so they
 * never run at once and each finishes or undoes an install the other left half done.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Proc } from "./engine.ts";
import { type Bundles, healthUrls, isHealthyResponse } from "./lib.ts";

/**
 * What the command line of a process holding the install lock contains: install:app's script,
 * or the updater's helper (its runner directory is named after it, see src/update/helper.ts).
 */
export const INSTALLER_MARKERS: ReadonlyArray<string> = ["install-app.ts", "apollo-update-helper"];

/**
 * Every process. Throws when `ps` fails or shows nothing (it always shows at least itself):
 * a list that could not be read must never pass for "nothing is running".
 */
export const processes = (): Array<{ pid: number; command: string }> => {
  const r = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 10_000 });
  if (r.error) throw new Error(`ps failed: ${r.error.message}`);
  if (r.status !== 0 || r.signal) throw new Error(`ps failed (${r.signal ?? `exit ${r.status}`}): ${(r.stderr ?? "").trim()}`);
  const list = (r.stdout ?? "").split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), command: match[2]! }] : [];
  });
  if (!list.some((p) => p.pid === process.pid)) throw new Error("ps returned an incomplete process list");
  return list;
};

/**
 * Every Apollo process in a process list: the app from any of its bundle paths, its servers
 * (whatever runtime runs server.mjs, APOLLO_NODE included), and, given a checkout, development
 * runs of it. `self` (the caller) is never one.
 */
export const classifyApollo = (
  list: ReadonlyArray<{ pid: number; command: string }>,
  bundles: Bundles,
  o: { readonly self: number; readonly repoRoot?: string | null },
): Array<Proc> => {
  const bundlePaths = Object.values(bundles) as Array<string>;
  return list.flatMap(({ pid, command }): Array<Proc> => {
    if (pid === o.self) return [];
    if (bundlePaths.some((b) => command.includes(`${b}/Contents/Resources/server/server.mjs`))) return [{ pid, kind: "server" }];
    if (o.repoRoot && command.includes(`${o.repoRoot}/apps/server/src/bin.ts`)) return [{ pid, kind: "server" }];
    if (bundlePaths.some((b) => command.startsWith(`${b}/Contents/MacOS/`))) return [{ pid, kind: "installed" }];
    if (o.repoRoot && /Electron\.app\/Contents\/MacOS\/Electron \.$/.test(command) && command.includes(o.repoRoot)) return [{ pid, kind: "development" }];
    return [];
  });
};

/** Whether `pid` is a running installer (install:app or the updater's helper); throws when that cannot be told. */
export const isInstallerPid = (pid: number, markers: ReadonlyArray<string> = INSTALLER_MARKERS): boolean => {
  const exists = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ESRCH: no such process. EPERM: another user's process, so not this user's installer.
      if (code === "ESRCH" || code === "EPERM") return false;
      throw error;
    }
  };
  if (!exists()) return false;
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
  if (!r.error && r.status === 0 && !r.signal) return markers.some((m) => r.stdout.includes(m));
  // ps -p exits 1 for a pid that just went away; anything else is "cannot tell".
  if (!r.error && r.status === 1 && !exists()) return false;
  throw new Error(`cannot tell whether pid ${pid} is an installer: ${r.error?.message ?? r.signal ?? `ps exit ${r.status}`}`);
};

/** Sessions mid-turn (or waiting on the user) in a database. */
export const busySessions = (path: string): Array<string> => {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("pragma busy_timeout = 3000");
    const rows = db
      .prepare(
        `select s.id, s.title, s.status, b.name as bot from sessions s left join bots b on b.id = s.bot_id
         where s.status in ('starting', 'running', 'waiting-approval')`,
      )
      .all() as Array<{ id: string; title: string; status: string; bot: string | null }>;
    return rows.map((r) => `${r.bot ?? "?"} / ${r.title} (${r.status}, ${r.id})`);
  } finally {
    db.close();
  }
};

/**
 * The packaged app starts its server on a free port it picks at launch (src/main.ts) and hands
 * it over as APOLLO_PORT (apps/server/src/Config.ts). Ask the servers of the app at `target` on
 * that port, only if they really listen there (lsof), else on their loopback ports.
 */
export const installedHealthy = async (target: string): Promise<boolean> => {
  for (const { pid, command } of processes()) {
    if (!command.includes(`${target}/Contents/Resources/server/server.mjs`)) continue;
    const env = spawnSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "";
    const lsof = spawnSync("lsof", ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n"], { encoding: "utf8" }).stdout ?? "";
    for (const url of healthUrls(env, lsof)) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (isHealthyResponse(response.status, await response.text())) return true;
      } catch {
        // not up yet
      }
    }
  }
  return false;
};
