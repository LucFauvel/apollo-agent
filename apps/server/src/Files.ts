import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import type { SessionId } from "@apollo/contracts";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
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

export const layer = Layer.mergeAll(layerRecordings, layerUpload, layerDownload);
