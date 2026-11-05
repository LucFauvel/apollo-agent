/**
 * Development runner: Apollo server (watch mode) + Vite web UI, and optionally
 * the Electron shell pointed at Vite.
 *
 *   pnpm dev            server + web   → open http://127.0.0.1:5733
 *   pnpm dev --desktop  server + web + Electron window
 *
 * Dev state lives in ./.apollo-dev unless APOLLO_DATA_DIR is set.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const desktop = process.argv.includes("--desktop");
const env = {
  ...process.env,
  APOLLO_PORT: process.env.APOLLO_PORT ?? "4317",
  APOLLO_DATA_DIR: process.env.APOLLO_DATA_DIR ?? resolve(root, ".apollo-dev"),
  // The Vite dev server's origin must be allowed to reach the API through its proxy.
  APOLLO_ALLOWED_ORIGINS: process.env.APOLLO_ALLOWED_ORIGINS ?? "http://127.0.0.1:5733,http://localhost:5733",
  // Pairing links printed by the server should open the Vite UI.
  APOLLO_PUBLIC_URL: process.env.APOLLO_PUBLIC_URL ?? "http://127.0.0.1:5733",
};

const children: Array<ChildProcess> = [];
const run = (name: string, args: Array<string>, extraEnv: Record<string, string> = {}) => {
  const child = spawn("pnpm", args, { cwd: root, env: { ...env, ...extraEnv }, stdio: "inherit" });
  child.on("exit", (code) => {
    console.log(`[dev] ${name} exited (${code ?? "signal"})`);
    shutdown(code ?? 0);
  });
  children.push(child);
};

let stopping = false;
const shutdown = (code: number) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  process.exitCode = code;
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (desktop) {
  // Electron starts its own server; it only needs Vite for the UI.
  run("web", ["--filter", "@apollo/web", "dev"]);
  run("desktop", ["--filter", "@apollo/desktop", "dev"]);
} else {
  run("server", ["--filter", "@apollo/server", "dev"]);
  run("web", ["--filter", "@apollo/web", "dev"]);
}
