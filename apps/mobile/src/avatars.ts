import type { Bot, BotAvatar } from "@apollo/contracts";
import { Directory, File, Paths } from "expo-file-system";
import { useEffect } from "react";
import { apiFetch, type Pairing } from "./connection.ts";

/**
 * Bot avatars as images, for the notification service extension (it shows each
 * notification as a message from its bot). The desktop app draws them; this app downloads
 * the ones its bots use into the app group both share, since the extension cannot reach
 * Apollo itself (the tailnet connection lives in this app).
 */
export const APP_GROUP = "group.dev.ocx64.apollo.mobile";

const keyOf = (avatar: BotAvatar) => `${avatar.shape}-${avatar.color}`;

const folder = (): Directory | null => {
  const shared = Paths.appleSharedContainers[APP_GROUP];
  return shared ? new Directory(shared, "avatars") : null;
};

let running: Promise<void> | null = null;

const sync = async (pairing: Pairing, keys: ReadonlyArray<string>) => {
  const dir = folder();
  if (!dir) return;
  dir.create({ intermediates: true, idempotent: true });
  for (const key of keys) {
    const file = new File(dir, `${key}.png`);
    if (file.exists) continue;
    // 404 until the desktop app has drawn it: tried again on the next sync.
    const response = await apiFetch(pairing, `/api/avatars/${key}.png`, { method: "GET" }).catch(() => null);
    if (!response?.ok) continue;
    await file.write(new Uint8Array(await response.arrayBuffer()));
  }
  // Avatars no bot uses anymore.
  for (const entry of dir.list()) {
    if (entry instanceof File && !keys.includes(entry.name.replace(/\.png$/, ""))) entry.delete();
  }
};

/** Downloads the images of the bots' avatars when they change, or the connection comes back. */
export const useAvatarImages = (pairing: Pairing, bots: ReadonlyMap<string, Bot>, connected: boolean) => {
  const keys = [...new Set([...bots.values()].map((bot) => keyOf(bot.avatar)))].sort();
  const signature = keys.join(",");
  useEffect(() => {
    if (!connected || keys.length === 0) return;
    running = (running ?? Promise.resolve()).then(() => sync(pairing, keys)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing, signature, connected]);
};
