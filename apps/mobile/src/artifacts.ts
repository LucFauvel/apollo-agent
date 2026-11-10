import type { ArtifactRef, AttachmentRef, SessionId } from "@apollo/contracts";
import { Directory, File, Paths } from "expo-file-system";
import { Platform, Share } from "react-native";
import { apiFetch, type Pairing } from "./connection.ts";

export const artifactPath = (a: ArtifactRef) => `/api/artifacts/${a.botId}/${a.artifactId}/${a.version}`;

/** The server's fallback HTML is the page itself for HTML artifacts up to this size. */
export const FALLBACK_IS_PAGE = 512 * 1024;

export const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const safeName = (name: string) => name.replace(/[/\\:\0]/g, "_") || "artifact";

const pending = new Map<string, Promise<File>>();

/**
 * A server file on this phone, downloaded once into the cache (what it points to never
 * changes), under its own name so sharing it keeps the name.
 */
const cachedDownload = (pairing: Pairing, path: string, folder: ReadonlyArray<string>, name: string, size: number | null): Promise<File> => {
  const existing = pending.get(path);
  if (existing) return existing;
  const download = (async () => {
    const dir = new Directory(Paths.cache, ...folder.map(safeName));
    const file = new File(dir, safeName(name));
    if (file.exists && (size === null || file.size === size)) return file;
    const response = await apiFetch(pairing, path, { method: "GET" });
    if (!response.ok) throw new Error(response.status === 404 ? "This file is no longer on disk." : `Could not load it (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    dir.create({ intermediates: true, idempotent: true });
    if (file.exists) file.delete();
    file.write(bytes);
    return file;
  })();
  pending.set(path, download);
  download.catch(() => pending.delete(path));
  return download;
};

export const artifactFile = (pairing: Pairing, a: ArtifactRef): Promise<File> =>
  cachedDownload(pairing, artifactPath(a), ["artifacts", a.botId, a.artifactId, String(a.version)], a.name, a.size);

export const attachmentFile = (pairing: Pairing, sessionId: SessionId, a: AttachmentRef): Promise<File> =>
  cachedDownload(pairing, `/api/attachments/${sessionId}/${a.id}`, ["attachments", sessionId, a.id], a.name, a.size);

/** The share sheet with the file itself on iOS (Save to Files, AirDrop, open in another app). */
export const shareFile = async (file: File, title: string) => {
  if (Platform.OS === "ios") await Share.share({ url: file.uri, title });
  else throw new Error("Sharing files from Android is not supported yet: open it in Apollo on your computer.");
};

export const artifactText = async (pairing: Pairing, a: ArtifactRef) => (await artifactFile(pairing, a)).text();

/** The share sheet with the file itself on iOS (Save to Files, AirDrop, open in another app). */
export const shareArtifact = async (pairing: Pairing, a: ArtifactRef) => {
  const file = await artifactFile(pairing, a);
  if (Platform.OS === "ios") await Share.share({ url: file.uri, title: a.title || a.name });
  else if (a.kind === "markdown" || a.kind === "code" || a.kind === "text" || a.kind === "html")
    await Share.share({ message: await file.text(), title: a.title || a.name });
  else throw new Error("Sharing files from Android is not supported yet: open it in Apollo on your computer.");
};

const framePath = (recordingId: string, n: number) => `/api/recordings/${recordingId}/${String(n).padStart(4, "0")}.jpg`;

/** Downloads a browser recording's frames into the cache (once), reporting progress; resolves to their URIs. */
export const recordingFrames = async (pairing: Pairing, recordingId: string, frames: number, onProgress: (done: number) => void) => {
  const dir = new Directory(Paths.cache, "recordings", safeName(recordingId));
  dir.create({ intermediates: true, idempotent: true });
  const uris: Array<string> = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < frames) {
      const n = next++;
      const file = new File(dir, `${String(n).padStart(4, "0")}.jpg`);
      if (!file.exists) {
        const response = await apiFetch(pairing, framePath(recordingId, n), { method: "GET" });
        if (!response.ok) throw new Error(response.status === 404 ? "This recording is no longer on disk." : `Could not load it (${response.status}).`);
        file.write(new Uint8Array(await response.arrayBuffer()));
      }
      uris[n] = file.uri;
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, frames) }, worker));
  return uris;
};
