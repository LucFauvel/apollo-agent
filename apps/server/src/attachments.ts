import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AttachmentRef } from "@apollo/contracts";

/** Files the user attached to messages: `<dataDir>/attachments/<sessionId>/<id>/<name>`. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ID = /^att_[0-9a-f]{12}$/;
const SESSION = /^ses_[A-Za-z0-9_-]+$/;

const root = (dataDir: string, sessionId: string) => join(dataDir, "attachments", sessionId);

/** A file name safe to store and show: no folders, no control characters. */
export const safeName = (name: string) =>
  basename(name)
    .replace(/[\u0000-\u001f/\\:*?"<>|]+/g, "_")
    .slice(0, 120)
    .trim() || "file";

export const saveAttachment = (dataDir: string, sessionId: string, name: string, mime: string, bytes: Uint8Array): AttachmentRef => {
  if (!SESSION.test(sessionId)) throw new Error("bad session id");
  const id = `att_${randomBytes(6).toString("hex")}`;
  const dir = join(root(dataDir, sessionId), id);
  mkdirSync(dir, { recursive: true });
  const ref: AttachmentRef = { id, name: safeName(name), mime: mime || "application/octet-stream", size: bytes.byteLength };
  writeFileSync(join(dir, ref.name), bytes);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(ref));
  return ref;
};

/** The stored attachment, with its path; `null` if the id is unknown for that session. */
export const findAttachment = (dataDir: string, sessionId: string, id: string): (AttachmentRef & { path: string }) | null => {
  if (!SESSION.test(sessionId) || !ID.test(id)) return null;
  const dir = join(root(dataDir, sessionId), id);
  if (!existsSync(join(dir, "meta.json"))) return null;
  const ref = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as AttachmentRef;
  return { ...ref, path: join(dir, ref.name) };
};

export const removeAttachments = (dataDir: string, sessionId: string) => {
  if (SESSION.test(sessionId)) rmSync(root(dataDir, sessionId), { recursive: true, force: true });
};
