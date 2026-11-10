import { makeInflight, runPool } from "@apollo/client";
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

const downloads = makeInflight<File>();

/**
 * A server file on this phone, downloaded into the cache (what it points to never changes),
 * under its own name so sharing it keeps the name. Every call checks the cache again: the
 * system may purge it while the app is suspended.
 */
const cachedDownload = (pairing: Pairing, path: string, folder: ReadonlyArray<string>, name: string, size: number | null): Promise<File> =>
  downloads(path, async () => {
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
  });

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

const frameFile = (recordingId: string, n: number) =>
  new File(new Directory(Paths.cache, "recordings", safeName(recordingId)), `${String(n).padStart(4, "0")}.jpg`);

const downloadFrame = async (pairing: Pairing, recordingId: string, n: number, signal?: AbortSignal) => {
  const file = frameFile(recordingId, n);
  if (file.exists) return file.uri;
  const response = await apiFetch(pairing, framePath(recordingId, n), { method: "GET", ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(response.status === 404 ? "This recording is no longer on disk." : `Could not load it (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  new Directory(Paths.cache, "recordings", safeName(recordingId)).create({ intermediates: true, idempotent: true });
  file.write(bytes);
  return file.uri;
};

/** A frame already on this phone (from an earlier playback), or null. */
export const cachedFrame = (recordingId: string, n: number) => {
  const file = frameFile(recordingId, n);
  return file.exists ? file.uri : null;
};

/**
 * Downloads a recording's frames into the cache (frames already there are kept), reporting
 * progress, until `signal` aborts; resolves to their URIs.
 */
export const recordingFrames = (pairing: Pairing, recordingId: string, frames: number, signal: AbortSignal, onProgress: (done: number) => void) =>
  runPool(frames, 4, (n, s) => downloadFrame(pairing, recordingId, n, s), signal, onProgress);
