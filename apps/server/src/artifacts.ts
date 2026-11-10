import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { ArtifactKind, ArtifactRef, BotId, SessionId } from "@apollo/contracts";
import { safeName } from "./attachments.ts";

/**
 * Files bots save to show the user: `<dataDir>/artifacts/<botId>/<artifactId>/meta.json`, and
 * each version under `v<n>/<name>`. Versions are never rewritten, so a conversation keeps
 * showing the version it was shown.
 */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

const ID = /^art_[0-9a-f]{12}$/;
const BOT = /^bot_[A-Za-z0-9_-]+$/;

interface Version {
  readonly version: number;
  readonly name: string;
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly mime: string;
  readonly size: number;
  readonly language?: string;
  readonly sessionId: string;
  readonly createdAt: number;
}

interface Meta {
  readonly artifactId: string;
  readonly botId: string;
  readonly createdAt: number;
  readonly versions: ReadonlyArray<Version>;
}

export interface StoredArtifact extends ArtifactRef {
  readonly path: string;
}

export interface ArtifactSummary {
  readonly artifactId: string;
  readonly title: string;
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly latestVersion: number;
  readonly size: number;
  readonly path: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const IMAGES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

const CODE: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".ps1": "powershell",
  ".sql": "sql",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".css": "css",
  ".scss": "scss",
  ".graphql": "graphql",
  ".diff": "diff",
  ".patch": "diff",
};

const TEXT: Record<string, string> = {
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
};

const OTHER: Record<string, string> = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const looksLikeText = (bytes: Uint8Array) => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 64 * 1024));
    return true;
  } catch {
    // A multi-byte character cut at the 64 KB mark is still text.
    return bytes.byteLength > 64 * 1024;
  }
};

/** How a file is shown, from its extension (and, for unknown ones, whether it is text). */
export const classify = (name: string, bytes: Uint8Array): { kind: ArtifactKind; mime: string; language?: string } => {
  const ext = extname(name).toLowerCase();
  if (ext === ".html" || ext === ".htm") return { kind: "html", mime: "text/html; charset=utf-8" };
  if (ext === ".md" || ext === ".markdown") return { kind: "markdown", mime: "text/markdown; charset=utf-8" };
  if (IMAGES[ext]) return { kind: "image", mime: IMAGES[ext] };
  if (CODE[ext]) return { kind: "code", mime: "text/plain; charset=utf-8", language: CODE[ext] };
  if (TEXT[ext]) return { kind: "text", mime: `${TEXT[ext]}; charset=utf-8` };
  if (OTHER[ext]) return { kind: "file", mime: OTHER[ext] };
  return looksLikeText(bytes) ? { kind: "text", mime: "text/plain; charset=utf-8" } : { kind: "file", mime: "application/octet-stream" };
};

const botRoot = (dataDir: string, botId: string) => join(dataDir, "artifacts", botId);
const dirOf = (dataDir: string, botId: string, artifactId: string) => join(botRoot(dataDir, botId), artifactId);

const readMeta = (dir: string): Meta | null => {
  try {
    return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Meta;
  } catch {
    return null;
  }
};

const writeMeta = (dir: string, meta: Meta) => {
  const tmp = join(dir, `meta.json.${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(meta));
  renameSync(tmp, join(dir, "meta.json"));
};

const toStored = (dir: string, meta: Meta, v: Version): StoredArtifact => ({
  artifactId: meta.artifactId,
  botId: meta.botId as BotId,
  version: v.version,
  name: v.name,
  title: v.title,
  kind: v.kind,
  mime: v.mime,
  size: v.size,
  ...(v.language ? { language: v.language } : {}),
  path: join(dir, `v${v.version}`, v.name),
});

export const isArtifactId = (id: string) => ID.test(id);

/**
 * Saves a new artifact, or a new version of `artifactId` (which must belong to the bot).
 * `name` and `title` default to the previous version's. Returns `null` for an unknown id.
 */
export const saveArtifact = (
  dataDir: string,
  input: {
    readonly botId: BotId;
    readonly sessionId: SessionId;
    readonly artifactId?: string | undefined;
    readonly name?: string | undefined;
    readonly title?: string | undefined;
    readonly bytes: Uint8Array;
  },
): StoredArtifact | null => {
  if (!BOT.test(input.botId)) throw new Error("bad bot id");
  if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("artifact is larger than 25 MB");
  let meta: Meta;
  let dir: string;
  if (input.artifactId !== undefined) {
    if (!ID.test(input.artifactId)) return null;
    dir = dirOf(dataDir, input.botId, input.artifactId);
    const existing = readMeta(dir);
    if (!existing) return null;
    meta = existing;
  } else {
    const artifactId = `art_${randomBytes(6).toString("hex")}`;
    dir = dirOf(dataDir, input.botId, artifactId);
    mkdirSync(dir, { recursive: true });
    meta = { artifactId, botId: input.botId, createdAt: Date.now(), versions: [] };
  }
  const previous = meta.versions.at(-1);
  const name = safeName(input.name?.trim() || previous?.name || "artifact.txt");
  const title = (input.title?.trim() || previous?.title || name).slice(0, 120);
  const version = (previous?.version ?? 0) + 1;
  const { kind, mime, language } = classify(name, input.bytes);
  const entry: Version = {
    version,
    name,
    title,
    kind,
    mime,
    size: input.bytes.byteLength,
    ...(language ? { language } : {}),
    sessionId: input.sessionId,
    createdAt: Date.now(),
  };
  mkdirSync(join(dir, `v${version}`), { recursive: true });
  writeFileSync(join(dir, `v${version}`, name), input.bytes);
  const next: Meta = { ...meta, versions: [...meta.versions, entry] };
  writeMeta(dir, next);
  return toStored(dir, next, entry);
};

/** A stored version (the latest when `version` is omitted), or `null`. */
export const findArtifact = (dataDir: string, botId: string, artifactId: string, version?: number): StoredArtifact | null => {
  if (!BOT.test(botId) || !ID.test(artifactId)) return null;
  const dir = dirOf(dataDir, botId, artifactId);
  const meta = readMeta(dir);
  if (!meta) return null;
  const v = version === undefined ? meta.versions.at(-1) : meta.versions.find((x) => x.version === version);
  return v ? toStored(dir, meta, v) : null;
};

/** The bot's artifacts, most recently updated first. */
export const listArtifacts = (dataDir: string, botId: string): Array<ArtifactSummary> => {
  if (!BOT.test(botId)) return [];
  const root = botRoot(dataDir, botId);
  if (!existsSync(root)) return [];
  const out: Array<ArtifactSummary> = [];
  for (const id of readdirSync(root)) {
    if (!ID.test(id)) continue;
    const dir = join(root, id);
    const meta = readMeta(dir);
    const latest = meta?.versions.at(-1);
    if (!meta || !latest) continue;
    out.push({
      artifactId: meta.artifactId,
      title: latest.title,
      name: latest.name,
      kind: latest.kind,
      latestVersion: latest.version,
      size: latest.size,
      path: join(dir, `v${latest.version}`, latest.name),
      createdAt: meta.createdAt,
      updatedAt: latest.createdAt,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
};

export const removeArtifacts = (dataDir: string, botId: string) => {
  if (BOT.test(botId)) rmSync(botRoot(dataDir, botId), { recursive: true, force: true });
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MAX_FALLBACK = 512 * 1024;

/**
 * What clients that do not know artifacts render instead: the page itself for HTML, the text
 * for text files, the picture for small images, else a card with its name.
 */
export const fallbackHtml = (artifact: ArtifactRef, bytes: Uint8Array): string => {
  const card = (note: string) =>
    `<div style="font:13px system-ui;padding:4px"><b>${escapeHtml(artifact.title)}</b> <span style="opacity:.6">${escapeHtml(artifact.name)} · v${artifact.version}</span><p style="opacity:.7">${escapeHtml(note)}</p></div>`;
  if (artifact.kind === "html" && bytes.byteLength <= MAX_FALLBACK) return new TextDecoder().decode(bytes);
  if (artifact.kind === "markdown" || artifact.kind === "code" || artifact.kind === "text") {
    const text = new TextDecoder().decode(bytes.subarray(0, MAX_FALLBACK - 4096));
    return `<pre style="white-space:pre-wrap;word-break:break-word;font:12px ui-monospace,monospace;margin:0">${escapeHtml(text)}</pre>`;
  }
  if (artifact.kind === "image" && bytes.byteLength * 1.37 < MAX_FALLBACK - 1024) {
    return `<img alt="${escapeHtml(artifact.title)}" style="max-width:100%" src="data:${artifact.mime};base64,${Buffer.from(bytes).toString("base64")}">`;
  }
  return card("Open Apollo on the desktop to see this file.");
};
