/**
 * `pnpm --filter @apollo/desktop test:e2e` (and CI's checks job): not part of `pnpm test`, whose
 * parallel package runs it would slow enough to time out other real-process tests.
 *
 * smoke.ts end to end on macOS against a scratch "app" (a Node script as the bundle executable),
 * the reviewer's P2-2 probe: the app migrates the seeded database, writes its capture, starts a
 * server child that answers /health once and then 503, and exits 0 while that child is still
 * alive. The smoke test must FAIL and kill the child. Control: the same app whose server stops
 * with it must pass.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../../server/src/Database.ts";

const here = dirname(fileURLToPath(import.meta.url));
const smoke = join(here, "smoke.ts");
const database = join(here, "../../../server/src/Database.ts");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY4QAAAAASUVORK5CYII=";

const scratchApp = (leftover: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "smoke-scratch-"));
  const app = join(root, "Scratch.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"));
  writeFileSync(join(app, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>scratch</string></dict></plist>');
  writeFileSync(join(app, "Contents", "Resources", "build-info.json"), JSON.stringify({ commit: "c".repeat(40), schemaVersion: SCHEMA_VERSION, version: "1.2.3", arch: "arm64" }));
  // The "server": answers /health once, then 503. Lives 8 s (longer than the grace) unless killed.
  const child = join(root, "server.mjs");
  writeFileSync(
    child,
    `import http from "node:http"; import fs from "node:fs";
const [pidfile, ack] = process.argv.slice(2); let n = 0;
const server = http.createServer((req, res) => { n++; res.writeHead(n === 1 ? 200 : 503, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: n === 1 })); if (n === 1) fs.writeFileSync(ack, "answered"); });
server.listen(0, "127.0.0.1", () => { fs.writeFileSync(pidfile, String(process.pid)); console.log("Listening on http://127.0.0.1:" + server.address().port); });
setTimeout(() => process.exit(0), 8000);`,
  );
  const program = `#!${process.execPath}
import fs from "node:fs"; import { spawn } from "node:child_process"; import { open } from ${JSON.stringify(database)};
open(process.env.APOLLO_DATA_DIR + "/apollo.db").close();
fs.writeFileSync(process.env.APOLLO_SCREENSHOT, Buffer.from(${JSON.stringify(PNG)}, "base64"));
const ack = process.env.APOLLO_DATA_DIR + "/ack";
const server = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(child)}, ${JSON.stringify(root)} + "/" + Date.now() + ".pid", ack], { stdio: ["ignore", "inherit", "inherit"], detached: ${leftover} });
${leftover ? "server.unref();" : ""}
while (!fs.existsSync(ack)) await new Promise((r) => setTimeout(r, 10));
${leftover ? "" : "server.kill(); await new Promise((r) => server.once('exit', r));"}
process.exit(0);`;
  writeFileSync(join(app, "Contents", "MacOS", "scratch"), program);
  chmodSync(join(app, "Contents", "MacOS", "scratch"), 0o755);
  return { root, app };
};

const pidsOf = (root: string) => readdirSync(root).filter((n) => n.endsWith(".pid")).map((n) => Number(readFileSync(join(root, n), "utf8")));
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.runIf(process.platform === "darwin")("smoke.ts against a scratch app", () => {
  it("fails when a server child survives the app, even answering 503, and kills it", { timeout: 90_000 }, () => {
    const { root, app } = scratchApp(true);
    const r = spawnSync(process.execPath, [smoke, "--app", app, "--timeout", "20"], { encoding: "utf8", timeout: 80_000 });
    const output = `${r.stdout}${r.stderr}`;
    expect(r.status, output).toBe(1);
    expect(output).toMatch(/still accepts connections on the server's port|processes still running/);
    expect(output).not.toMatch(/smoke test passed/);
    const pids = pidsOf(root);
    expect(pids).toHaveLength(2); // one per seed version
    expect(pids.filter(isAlive)).toEqual([]);
  });

  it("passes when the app's server stops with it", { timeout: 90_000 }, () => {
    const { root, app } = scratchApp(false);
    const r = spawnSync(process.execPath, [smoke, "--app", app, "--timeout", "20"], { encoding: "utf8", timeout: 80_000 });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/smoke test passed/);
    expect(existsSync(root)).toBe(true);
  });
});
