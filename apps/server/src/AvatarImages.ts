import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AVATAR_COLORS, AVATAR_SHAPES, type BotAvatar } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { isLocal } from "./auth/http.ts";
import { ServerConfig } from "./Config.ts";
import { Tailscale } from "./remote/Tailscale.ts";
import { Store } from "./Store.ts";

/**
 * Bot avatars as PNG images, for the phone's notifications (which show the bot as the
 * sender). The desktop app draws them, from the same component the UI uses, and uploads
 * the ones in use; phones download them when they sync. Only avatars some bot uses are
 * kept: a changed avatar is drawn again, the old image removed.
 */

/** `<shape>-<color>.png`, the file name for an avatar. */
export const avatarKey = (avatar: BotAvatar) => `${avatar.shape}-${avatar.color}`;

const KEY = new RegExp(`^(${AVATAR_SHAPES.join("|")})-(${AVATAR_COLORS.join("|")})$`);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_BYTES = 256 * 1024;

export const isPng = (bytes: Uint8Array) => PNG_SIGNATURE.every((b, i) => bytes[i] === b);

const dirOf = (dataDir: string) => join(dataDir, "avatars");
const keyOf = (file: string) => (file.endsWith(".png") && KEY.test(file.slice(0, -4)) ? file.slice(0, -4) : null);

export const cachedKeys = (dataDir: string): Array<string> => {
  try {
    return readdirSync(dirOf(dataDir)).flatMap((f) => keyOf(f) ?? []);
  } catch {
    return [];
  }
};

/** Removes images no bot uses. */
export const pruneAvatars = (dataDir: string, inUse: ReadonlySet<string>) => {
  for (const key of cachedKeys(dataDir)) if (!inUse.has(key)) rmSync(join(dirOf(dataDir), `${key}.png`), { force: true });
};

const notFound = HttpServerResponse.text("Not found", { status: 404 });
const keyParam = (file: string | undefined) => (file ? keyOf(file) : null);

/** `GET /api/avatars`: the avatars in use, and which already have an image. */
const layerList = HttpRouter.add(
  "GET",
  "/api/avatars",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const store = yield* Store;
    const inUse = [...new Set((yield* store.listBots).map((bot) => avatarKey(bot.avatar)))];
    const cached = new Set(cachedKeys(config.dataDir));
    return HttpServerResponse.jsonUnsafe({ inUse, cached: inUse.filter((k) => cached.has(k)) });
  }),
);

/** `GET /api/avatars/<shape>-<color>.png` */
const layerGet = HttpRouter.add(
  "GET",
  "/api/avatars/:file",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const key = keyParam((yield* HttpRouter.params).file);
    if (!key) return notFound;
    try {
      return HttpServerResponse.uint8Array(readFileSync(join(dirOf(config.dataDir), `${key}.png`)), { contentType: "image/png" }).pipe(
        HttpServerResponse.setHeader("cache-control", "private, max-age=86400"),
      );
    } catch {
      return notFound;
    }
  }),
);

/** `PUT /api/avatars/<shape>-<color>.png` with the PNG as the body, from the desktop app only. */
const layerPut = HttpRouter.add(
  "PUT",
  "/api/avatars/:file",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const store = yield* Store;
    const tailscale = yield* Tailscale;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!isLocal(tailscale, request)) return HttpServerResponse.text("Avatars are drawn on the computer", { status: 403 });
    const key = keyParam((yield* HttpRouter.params).file);
    if (!key) return notFound;
    const body = yield* request.arrayBuffer.pipe(Effect.option);
    if (body._tag === "None") return HttpServerResponse.text("Could not read the upload", { status: 400 });
    const bytes = new Uint8Array(body.value);
    if (bytes.byteLength > MAX_BYTES || !isPng(bytes)) return HttpServerResponse.text("Expected a PNG up to 256 KB", { status: 400 });
    const inUse = new Set((yield* store.listBots).map((bot) => avatarKey(bot.avatar)));
    if (!inUse.has(key)) return HttpServerResponse.text("No bot uses this avatar", { status: 409 });
    mkdirSync(dirOf(config.dataDir), { recursive: true });
    writeFileSync(join(dirOf(config.dataDir), `${key}.png`), bytes);
    pruneAvatars(config.dataDir, inUse);
    return HttpServerResponse.jsonUnsafe({ ok: true });
  }),
);

export const layer = Layer.mergeAll(layerList, layerGet, layerPut);
