import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import type { SessionId } from "@apollo/contracts";
import { AppSettings } from "./AppSettings.ts";
import { fromDesktopShell } from "./DesktopStatus.ts";
import { fileErrorMessage, type FileRoots, resolveLocalFile } from "./localFiles.ts";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { findArtifact } from "./artifacts.ts";
import { findAttachment, MAX_ATTACHMENT_BYTES, saveAttachment } from "./attachments.ts";
import { Store } from "./Store.ts";
import { ServerConfig } from "./Config.ts";

/**
 * Files the UI shows inside conversations. Every `/api/` path requires a paired
 * device (see auth/http.ts); ids are checked so paths cannot leave their folder.
 */
const notFound = HttpServerResponse.text("Not found", { status: 404 });

/** `GET /api/recordings/<rec_id>/<0000>.jpg`: one frame of a browser recording. */
const layerRecordings = HttpRouter.add(
  "GET",
  "/api/recordings/:id/:frame",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const { id, frame } = yield* HttpRouter.params;
    if (!id || !/^rec_[0-9a-f]{12}$/.test(id) || !frame || !/^\d{4}\.jpg$/.test(frame)) return notFound;
    try {
      const bytes = readFileSync(join(config.dataDir, "recordings", id, frame));
      return HttpServerResponse.uint8Array(bytes, { contentType: "image/jpeg" }).pipe(
        HttpServerResponse.setHeader("cache-control", "private, max-age=86400, immutable"),
      );
    } catch {
      return notFound;
    }
  }),
);

/**
 * `POST /api/attachments/<sessionId>?name=<file name>` with the raw file as the body: stores
 * it for a message and returns its AttachmentRef. `GET /api/attachments/<sessionId>/<id>`
 * serves it back (thumbnails, downloads).
 */
const layerUpload = HttpRouter.add(
  "POST",
  "/api/attachments/:sessionId",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const store = yield* Store;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { sessionId } = yield* HttpRouter.params;
    const query = yield* HttpServerRequest.ParsedSearchParams;
    const name = typeof query.name === "string" ? query.name : "file";
    const exists = yield* store.getSession((sessionId ?? "") as SessionId).pipe(Effect.option);
    if (!sessionId || exists._tag === "None") return notFound;
    const length = Number(request.headers["content-length"] ?? 0);
    if (length > MAX_ATTACHMENT_BYTES) return HttpServerResponse.text("File is larger than 25 MB", { status: 413 });
    const body = yield* request.arrayBuffer.pipe(Effect.option);
    if (body._tag === "None") return HttpServerResponse.text("Could not read the upload", { status: 400 });
    if (body.value.byteLength > MAX_ATTACHMENT_BYTES) return HttpServerResponse.text("File is larger than 25 MB", { status: 413 });
    const mime = (request.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();
    const ref = saveAttachment(config.dataDir, sessionId, name, mime, new Uint8Array(body.value));
    return HttpServerResponse.jsonUnsafe(ref);
  }),
);

const layerDownload = HttpRouter.add(
  "GET",
  "/api/attachments/:sessionId/:id",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const { sessionId, id } = yield* HttpRouter.params;
    const found = sessionId && id ? findAttachment(config.dataDir, sessionId, id) : null;
    if (!found) return notFound;
    try {
      const inline = /^image\/(png|jpe?g|gif|webp)$/.test(found.mime);
      return HttpServerResponse.uint8Array(readFileSync(found.path), { contentType: found.mime }).pipe(
        HttpServerResponse.setHeader("cache-control", "private, max-age=86400, immutable"),
        HttpServerResponse.setHeader(
          "content-disposition",
          `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(found.name)}`,
        ),
        // Uploaded HTML or SVG must never run as a page on Apollo's origin.
        HttpServerResponse.setHeader("content-security-policy", "sandbox"),
        HttpServerResponse.setHeader("x-content-type-options", "nosniff"),
      );
    } catch {
      return notFound;
    }
  }),
);

/**
 * `GET /api/artifacts/<botId>/<artifactId>/<version>`: a version of an artifact a bot saved.
 * `?download=1` serves it as a download.
 */
const layerArtifacts = HttpRouter.add(
  "GET",
  "/api/artifacts/:botId/:id/:version",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const { botId, id, version } = yield* HttpRouter.params;
    const query = yield* HttpServerRequest.ParsedSearchParams;
    if (!botId || !id || !version || !/^\d+$/.test(version)) return notFound;
    const found = findArtifact(config.dataDir, botId, id, Number(version));
    if (!found) return notFound;
    try {
      const download = query.download === "1";
      return HttpServerResponse.uint8Array(readFileSync(found.path), { contentType: found.mime }).pipe(
        HttpServerResponse.setHeader("cache-control", "private, max-age=86400, immutable"),
        HttpServerResponse.setHeader(
          "content-disposition",
          `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(found.name)}`,
        ),
        // Agent-written HTML or SVG must never run as a page on Apollo's origin.
        HttpServerResponse.setHeader("content-security-policy", "sandbox"),
        HttpServerResponse.setHeader("x-content-type-options", "nosniff"),
      );
    } catch {
      return notFound;
    }
  }),
);

/** Local files larger than this are not served (they are read into memory); the desktop app still opens them. */
export const MAX_LOCAL_FILE_BYTES = 100 * 1024 * 1024;

const sessionRoots = (sessionId: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const appSettings = yield* AppSettings;
    const session = yield* store.getSession(sessionId as SessionId).pipe(Effect.option);
    if (session._tag === "None") return null;
    const bot = yield* store.getBot(session.value.botId).pipe(Effect.option);
    const { projectFolders } = yield* appSettings.read;
    return {
      sessionCwd: session.value.cwd,
      roots: [
        ...(bot._tag === "Some" ? [bot.value.cwd] : []),
        ...(session.value.worktree ? [session.value.worktree.path] : []),
        ...projectFolders,
      ],
      home: homedir(),
    } satisfies FileRoots;
  });

/** A file a message links to, checked against the session's roots. */
const localFile = (sessionId: string | undefined, path: unknown) =>
  Effect.gen(function* () {
    const roots = sessionId ? yield* sessionRoots(sessionId) : null;
    if (!roots || typeof path !== "string") return { ok: false as const, status: 404, error: "Not found" };
    const resolved = resolveLocalFile(path, roots);
    if (!resolved.ok) return { ok: false as const, status: resolved.reason === "outside" ? 403 : 404, error: fileErrorMessage(resolved.reason) };
    return { ok: true as const, info: resolved.info };
  });

/**
 * `GET /api/files/<sessionId>/info?path=<path>`: what a path a message mentions points to
 * (`LocalFileInfo`), if it is inside the session's folder, its bot's workspace or a project
 * folder. Relative paths are relative to the session's folder.
 */
const layerLocalInfo = HttpRouter.add(
  "GET",
  "/api/files/:sessionId/info",
  Effect.gen(function* () {
    const { sessionId } = yield* HttpRouter.params;
    const query = yield* HttpServerRequest.ParsedSearchParams;
    const found = yield* localFile(sessionId, query.path);
    if (!found.ok) return HttpServerResponse.jsonUnsafe({ error: found.error }, { status: found.status });
    return HttpServerResponse.jsonUnsafe(found.info).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
  }),
);

/** `GET /api/files/<sessionId>/content?path=<path>`: that file's bytes. `?download=1` serves it as a download. */
const layerLocalContent = HttpRouter.add(
  "GET",
  "/api/files/:sessionId/content",
  Effect.gen(function* () {
    const { sessionId } = yield* HttpRouter.params;
    const query = yield* HttpServerRequest.ParsedSearchParams;
    const found = yield* localFile(sessionId, query.path);
    if (!found.ok) return HttpServerResponse.text(found.error, { status: found.status });
    if (found.info.directory) return HttpServerResponse.text("This is a folder: open it in Apollo on your computer.", { status: 400 });
    if (found.info.size > MAX_LOCAL_FILE_BYTES) return HttpServerResponse.text("This file is larger than 100 MB: open it in Apollo on your computer.", { status: 413 });
    try {
      return HttpServerResponse.uint8Array(readFileSync(found.info.path), { contentType: found.info.mime }).pipe(
        HttpServerResponse.setHeader("cache-control", "no-store"),
        HttpServerResponse.setHeader(
          "content-disposition",
          `${query.download === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(found.info.name)}`,
        ),
        // A local HTML or SVG file must never run as a page on Apollo's origin.
        HttpServerResponse.setHeader("content-security-policy", "sandbox"),
        HttpServerResponse.setHeader("x-content-type-options", "nosniff"),
      );
    } catch {
      return notFound;
    }
  }),
);

/**
 * `GET /api/desktop/file?sessionId=<id>&path=<path>` for the desktop shell (bootstrap token):
 * the same check as `/api/files/<sessionId>/info`, before it opens the file on this computer.
 */
const layerDesktopFile = HttpRouter.add(
  "GET",
  "/api/desktop/file",
  Effect.gen(function* () {
    if (!(yield* fromDesktopShell)) return HttpServerResponse.jsonUnsafe({ error: "Only the desktop app may ask this." }, { status: 401 });
    const query = yield* HttpServerRequest.ParsedSearchParams;
    const found = yield* localFile(typeof query.sessionId === "string" ? query.sessionId : undefined, query.path);
    if (!found.ok) return HttpServerResponse.jsonUnsafe({ error: found.error }, { status: found.status });
    return HttpServerResponse.jsonUnsafe(found.info);
  }),
);

export const layer = Layer.mergeAll(
  layerRecordings,
  layerUpload,
  layerDownload,
  layerArtifacts,
  layerLocalInfo,
  layerLocalContent,
  layerDesktopFile,
);
