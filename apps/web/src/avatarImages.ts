import type { Bot, BotAvatar } from "@apollo/contracts";
import { createElement, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BlobAvatar } from "./components/BlobAvatar.tsx";

/**
 * Draws bot avatars as PNG images for the phone's notifications (the bot shows as the
 * sender), from the same BlobAvatar the UI uses, and uploads the ones the server does not
 * have yet. The server keeps only avatars in use, so a changed avatar is drawn again here.
 */

const SIZE = 180; // 60pt at 3x: iOS shows a sender's picture at about 40pt.
const TILE = "#18181b"; // Apollo's dark tile, behind the avatar (iOS rounds it to a circle).

const keyOf = (avatar: BotAvatar) => `${avatar.shape}-${avatar.color}`;

/** The avatar as standalone SVG markup, rendered by the UI's own component. */
const svgMarkup = (avatar: BotAvatar) => {
  const host = document.createElement("div");
  const root = createRoot(host);
  flushSync(() => root.render(createElement(BlobAvatar, { avatar, size: 128 })));
  const svg = host.querySelector("svg");
  const markup = svg ? new XMLSerializer().serializeToString(svg) : null;
  root.unmount();
  return markup;
};

const drawPng = async (avatar: BotAvatar): Promise<Blob | null> => {
  const markup = svgMarkup(avatar);
  if (!markup) return null;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = TILE;
  context.fillRect(0, 0, SIZE, SIZE);
  // The avatar's 32-unit canvas inside a 44-unit tile, as on the phone.
  const inset = (SIZE * 6) / 44;
  context.drawImage(image, inset, inset, SIZE - 2 * inset, SIZE - 2 * inset);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
};

let running: Promise<void> | null = null;

const sync = async (bots: ReadonlyArray<Bot>) => {
  const response = await fetch("/api/avatars", { credentials: "same-origin" });
  if (!response.ok) return;
  const { inUse, cached } = (await response.json()) as { inUse: Array<string>; cached: Array<string> };
  const missing = new Set(inUse.filter((key) => !cached.includes(key)));
  for (const bot of bots) {
    const key = keyOf(bot.avatar);
    if (!missing.delete(key)) continue;
    const png = await drawPng(bot.avatar).catch(() => null);
    if (png) {
      await fetch(`/api/avatars/${key}.png`, { method: "PUT", credentials: "same-origin", headers: { "content-type": "image/png" }, body: png });
    }
  }
};

/** Keeps the server's avatar images in step with the bots (new bots, changed avatars). */
export const useAvatarImages = (bots: ReadonlyMap<string, Bot>) => {
  const signature = [...bots.values()].map((bot) => keyOf(bot.avatar)).sort().join(",");
  useEffect(() => {
    if (!signature) return;
    const list = [...bots.values()];
    const previous = running ?? Promise.resolve();
    running = previous.then(() => sync(list)).catch(() => undefined);
    // Only the avatar keys matter: other bot changes do not draw anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
};
