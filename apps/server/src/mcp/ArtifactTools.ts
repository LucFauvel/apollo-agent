import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { ApolloError, ArtifactKind } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import {
  fallbackHtml,
  findArtifact,
  isArtifactId,
  listArtifacts,
  MAX_ARTIFACT_BYTES,
  removeArtifacts,
  saveArtifact,
  type StoredArtifact,
} from "../artifacts.ts";
import { ServerConfig } from "../Config.ts";
import { SessionManager } from "../SessionManager.ts";
import { McpCaller } from "./Caller.ts";

/** Artifacts: files a bot saves on disk, versioned, and shows the user in the conversation. */

const shared = {
  failure: ApolloError,
  failureMode: "return" as const,
  dependencies: [McpCaller],
};

const Saved = Schema.Struct({
  artifactId: Schema.String,
  version: Schema.Number,
  name: Schema.String,
  title: Schema.String,
  kind: ArtifactKind,
  size: Schema.Number,
  path: Schema.String,
  shown: Schema.Boolean,
});

const Save = Tool.make("apollo_artifact_save", {
  ...shared,
  description: [
    "Save a file as an artifact (stored on disk by Apollo, kept across sessions) and show it to the user in the",
    "conversation: a document, report, page, script, diagram, image or any file they should see or keep.",
    "Give the text in `content`, or the absolute `path` of a file to copy (images, PDFs, generated files).",
    "`name` is its file name; the extension decides how it is shown: .html renders as a page (self-contained,",
    "in a sandboxed frame like apollo_show_html), .md as formatted text, code and text files highlighted, images inline,",
    "anything else as a download. To change an artifact, save again with its `artifactId`: that adds a version",
    "(earlier messages keep showing theirs). `show: false` saves without showing. Returns the stored file's `path`",
    "(read it, never edit it in place). Prefer it over apollo_show_html for anything worth keeping or revising.",
  ].join(" "),
  parameters: Schema.Struct({
    name: Schema.optional(Schema.String).annotate({
      description: "File name with extension, e.g. report.md. Required for a new artifact unless `path` is given.",
    }),
    content: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    artifactId: Schema.optional(Schema.String),
    show: Schema.optional(Schema.Boolean),
  }),
  success: Saved,
});

const Show = Tool.make("apollo_artifact_show", {
  ...shared,
  description: "Show one of the bot's artifacts in this conversation again: its latest version, or `version`.",
  parameters: Schema.Struct({ artifactId: Schema.String, version: Schema.optional(Schema.Number) }),
  success: Saved,
}).annotate(Tool.Destructive, false);

const List = Tool.make("apollo_artifact_list", {
  ...shared,
  description: [
    "List the bot's artifacts, most recently updated first: id, title, file name, kind, latest version and path.",
    "`query` filters by title or name (case-insensitive).",
  ].join(" "),
  parameters: Schema.Struct({ query: Schema.optional(Schema.String) }),
  success: Schema.Struct({
    artifacts: Schema.Array(
      Schema.Struct({
        artifactId: Schema.String,
        title: Schema.String,
        name: Schema.String,
        kind: ArtifactKind,
        latestVersion: Schema.Number,
        size: Schema.Number,
        path: Schema.String,
        updatedAt: Schema.Number,
      }),
    ),
    truncated: Schema.Boolean,
  }),
}).annotate(Tool.Readonly, true);

const Read = Tool.make("apollo_artifact_read", {
  ...shared,
  description: [
    "Read one of the bot's artifacts (latest version, or `version`): its details, its path on disk, and its text",
    "for text kinds (up to 256 KB; `content` is null for images and other files: open `path` instead).",
  ].join(" "),
  parameters: Schema.Struct({ artifactId: Schema.String, version: Schema.optional(Schema.Number) }),
  success: Schema.Struct({
    artifactId: Schema.String,
    version: Schema.Number,
    name: Schema.String,
    title: Schema.String,
    kind: ArtifactKind,
    size: Schema.Number,
    path: Schema.String,
    content: Schema.NullOr(Schema.String),
    truncated: Schema.Boolean,
  }),
}).annotate(Tool.Readonly, true);

export const ArtifactToolkit = Toolkit.make(Save, Show, List, Read);

const invalid = (message: string) => new ApolloError({ code: "invalid", message });
const notFound = (artifactId: string) => new ApolloError({ code: "not_found", message: `no artifact ${artifactId} for this bot` });

const MAX_READ = 256 * 1024;
const TEXT_KINDS: ReadonlyArray<string> = ["html", "markdown", "code", "text"];

/** The bytes to save: `content` as UTF-8, or the file at an absolute `path`. */
export const artifactBytes = (content: string | undefined, path: string | undefined): Uint8Array | ApolloError => {
  if (content !== undefined && path !== undefined) return invalid("give either `content` or `path`, not both");
  if (content !== undefined) {
    const bytes = new TextEncoder().encode(content);
    return bytes.byteLength > MAX_ARTIFACT_BYTES ? invalid("`content` is over 25 MB") : bytes;
  }
  if (path === undefined) return invalid("give the file's text in `content`, or its absolute `path`");
  if (!isAbsolute(path)) return invalid("`path` must be absolute");
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return invalid(`${path} is not a file`);
    if (stat.size > MAX_ARTIFACT_BYTES) return invalid(`${path} is over 25 MB`);
    return new Uint8Array(readFileSync(path));
  } catch (error) {
    return invalid(`could not read ${path}: ${(error as Error).message}`);
  }
};

const result = (a: StoredArtifact, shown: boolean) => ({
  artifactId: a.artifactId,
  version: a.version,
  name: a.name,
  title: a.title,
  kind: a.kind,
  size: a.size,
  path: a.path,
  shown,
});

export const handlers = ArtifactToolkit.toLayer(
  Effect.gen(function* () {
    const manager = yield* SessionManager;
    const config = yield* ServerConfig;
    yield* manager.onBotDeleted("artifacts", (botId) => Effect.sync(() => removeArtifacts(config.dataDir, botId)));

    const show = (sessionId: Parameters<typeof manager.appendEvent>[0], a: StoredArtifact, bytes: Uint8Array) => {
      const { path: _path, ...artifact } = a;
      return manager.appendEvent(sessionId, {
        _tag: "Visual",
        visualId: `${a.artifactId}@${a.version}`,
        title: a.title,
        html: fallbackHtml(artifact, bytes),
        height: null,
        artifact,
      });
    };

    return {
      apollo_artifact_save: ({ name, content, path, title, artifactId, show: shouldShow }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          if (artifactId !== undefined && !isArtifactId(artifactId)) return yield* notFound(artifactId);
          const bytes = artifactBytes(content, path);
          if (bytes instanceof ApolloError) return yield* bytes;
          const fileName = name?.trim() || (path !== undefined ? basename(path) : undefined);
          if (!fileName && artifactId === undefined) return yield* invalid("give the artifact a file `name`, e.g. notes.md");
          const saved = yield* Effect.try({
            try: () =>
              saveArtifact(config.dataDir, {
                botId: caller.botId,
                sessionId: caller.sessionId,
                artifactId,
                name: fileName,
                title,
                bytes,
              }),
            catch: (error) => new ApolloError({ code: "internal", message: `could not save the artifact: ${(error as Error).message}` }),
          });
          if (!saved) return yield* notFound(artifactId!);
          const visible = shouldShow ?? true;
          if (visible) yield* show(caller.sessionId, saved, bytes);
          return result(saved, visible);
        }),

      apollo_artifact_show: ({ artifactId, version }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const found = findArtifact(config.dataDir, caller.botId, artifactId, version);
          if (!found) return yield* notFound(version === undefined ? artifactId : `${artifactId} v${version}`);
          const bytes = yield* Effect.try({
            try: () => new Uint8Array(readFileSync(found.path)),
            catch: () => new ApolloError({ code: "not_found", message: `the file of ${artifactId} is missing on disk` }),
          });
          yield* show(caller.sessionId, found, bytes);
          return result(found, true);
        }),

      apollo_artifact_list: ({ query }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const q = query?.trim().toLowerCase();
          const all = listArtifacts(config.dataDir, caller.botId);
          const matching = q ? all.filter((a) => a.title.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)) : all;
          return {
            artifacts: matching.slice(0, 200).map(({ createdAt: _createdAt, ...a }) => a),
            truncated: matching.length > 200,
          };
        }),

      apollo_artifact_read: ({ artifactId, version }) =>
        Effect.gen(function* () {
          const caller = yield* McpCaller;
          const found = findArtifact(config.dataDir, caller.botId, artifactId, version);
          if (!found) return yield* notFound(version === undefined ? artifactId : `${artifactId} v${version}`);
          const isText = TEXT_KINDS.includes(found.kind);
          const bytes = isText
            ? yield* Effect.try({
                try: () => readFileSync(found.path),
                catch: () => new ApolloError({ code: "not_found", message: `the file of ${artifactId} is missing on disk` }),
              })
            : null;
          return {
            artifactId: found.artifactId,
            version: found.version,
            name: found.name,
            title: found.title,
            kind: found.kind,
            size: found.size,
            path: found.path,
            content: bytes ? new TextDecoder().decode(bytes.subarray(0, MAX_READ)) : null,
            truncated: bytes !== null && bytes.byteLength > MAX_READ,
          };
        }),
    };
  }),
);
