import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export interface ServerConfigShape {
  readonly host: string;
  readonly port: number;
  /** Where the SQLite database and other state live. */
  readonly dataDir: string;
  /** Built web UI to serve at `/`, if present. */
  readonly webDistDir: string | null;
  /** Public base URL agents use to reach the MCP endpoint. */
  readonly baseUrl: string;
  readonly claudeExecutable: string | undefined;
  readonly codexExecutable: string | undefined;
  /**
   * Claude Code's binary comes with the Agent SDK (development runs). The installed app does
   * not ship it, so it needs the `claude` CLI. Unset: bundled.
   */
  readonly claudeBundled?: boolean;
  /** The tailnet addon (apps/server/native/tailnet), loaded to publish Apollo on the tailnet. */
  readonly tailnetAddon: string | undefined;
  /** Defaults for the llama.cpp provider until changed in the settings. */
  readonly llamaCpp: { readonly baseUrl: string; readonly apiKey: string | null };
  /**
   * Browser origins allowed to call the server. Requests without an `Origin`
   * header (CLIs, agents, Electron's own server checks) are always allowed.
   */
  readonly allowedOrigins: ReadonlyArray<string>;
  /** URL of the UI, used when printing pairing links (the Vite origin in development). */
  readonly publicUrl: string;
  /** Per-launch secret from the desktop app; lets it pair itself without user action. */
  readonly desktopBootstrapToken: string | undefined;
  readonly storage: StoragePolicy;
  readonly browser: {
    /** A Chromium-based browser to run; found automatically when unset. */
    readonly executable: string | undefined;
    /** Run without a window (the UI shows a live view either way). */
    readonly headless: boolean;
  };
}

/** Limits that keep Apollo's database from growing without bound (see Compaction.ts). */
export interface StoragePolicy {
  /** Compaction works harder when the database is larger than this. */
  readonly budgetBytes: number;
  /** Archive memories kept per scope (each bot, and global); least recently used go first. */
  readonly archiveLimit: number;
  /** Tool output and reasoning older than this are trimmed to a short excerpt. */
  readonly detailRetentionMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const positive = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "apollo/ServerConfig",
) {}

export const fromEnv = (env: NodeJS.ProcessEnv = process.env): ServerConfigShape => {
  const host = env.APOLLO_HOST ?? "127.0.0.1";
  const port = Number(env.APOLLO_PORT ?? 4317);
  const baseUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  return {
    host,
    port,
    dataDir: resolve(env.APOLLO_DATA_DIR ?? join(homedir(), ".apollo")),
    webDistDir: env.APOLLO_WEB_DIST ? resolve(env.APOLLO_WEB_DIST) : null,
    baseUrl,
    publicUrl: env.APOLLO_PUBLIC_URL ?? baseUrl,
    desktopBootstrapToken: env.APOLLO_DESKTOP_BOOTSTRAP_TOKEN || undefined,
    storage: {
      budgetBytes: positive(env.APOLLO_MAX_STORAGE_MB, 2048) * 1024 * 1024,
      archiveLimit: Math.floor(positive(env.APOLLO_MEMORY_ARCHIVE_LIMIT, 2000)),
      detailRetentionMs: positive(env.APOLLO_DETAIL_RETENTION_DAYS, 30) * DAY_MS,
    },
    browser: {
      executable: env.APOLLO_BROWSER_BIN || undefined,
      headless: env.APOLLO_BROWSER_HEADLESS !== "0",
    },
    claudeExecutable: env.APOLLO_CLAUDE_BIN,
    codexExecutable: env.APOLLO_CODEX_BIN,
    claudeBundled: env.APOLLO_CLAUDE_BUNDLED !== "0",
    tailnetAddon: env.APOLLO_TAILNET_ADDON || undefined,
    llamaCpp: {
      baseUrl: env.APOLLO_LLAMACPP_URL || "http://127.0.0.1:8080",
      apiKey: env.APOLLO_LLAMACPP_API_KEY || null,
    },
    allowedOrigins: [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      ...(env.APOLLO_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ],
  };
};

export const layerFromEnv = Layer.sync(ServerConfig, () => fromEnv());
