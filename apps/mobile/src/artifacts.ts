import { makeInflight, runPool } from "@apollo/client";
import type { ArtifactKind, ArtifactRef, AttachmentRef, SessionId } from "@apollo/contracts";
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

/** What `/api/files/<sessionId>/info` says about a path a message links to (LocalFileInfo on the server). */
export interface LocalFileInfo {
  readonly path: string;
  readonly name: string;
  readonly directory: boolean;
  readonly size: number;
  readonly modifiedAt: number;
  readonly kind: ArtifactKind;
  readonly mime: string;
  readonly language?: string;
}

/** Local files larger than this are not served (MAX_LOCAL_FILE_BYTES on the server). */
export const MAX_LOCAL_FILE_BYTES = 100 * 1024 * 1024;

const query = (params: Record<string, string>) =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

export const localFileInfo = async (pairing: Pairing, sessionId: SessionId, path: string): Promise<LocalFileInfo> => {
  const response = await apiFetch(pairing, `/api/files/${sessionId}/info?${query({ path })}`, { method: "GET" });
  const body = (await response.json().catch(() => null)) as (LocalFileInfo & { error?: string }) | null;
  if (!response.ok || !body || typeof body.path !== "string") {
    throw new Error(body?.error ?? (response.status === 404 ? "This file is not on disk." : `Could not open it (${response.status}).`));
  }
  return body;
};

const hash = (text: string) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

/** A local file downloaded through the server; a changed file (time or size) is downloaded again. */
export const localFile = (pairing: Pairing, sessionId: SessionId, info: LocalFileInfo): Promise<File> =>
  cachedDownload(
    pairing,
    `/api/files/${sessionId}/content?${query({ path: info.path })}`,
    ["files", sessionId, hash(`${info.path}\n${info.modifiedAt}\n${info.size}`)],
    info.name,
    info.size,
  );

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
