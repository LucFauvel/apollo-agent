import type { AttachmentRef, SessionId } from "@apollo/contracts";
import { FileText, Loader2, X } from "lucide-react";
import { useCallback, useState } from "react";
import { cx } from "./ui.tsx";

const MAX_BYTES = 25 * 1024 * 1024;

export const attachmentUrl = (sessionId: SessionId, id: string) => `/api/attachments/${sessionId}/${id}`;

const isImage = (mime: string) => /^image\/(png|jpe?g|gif|webp)$/.test(mime);

const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

interface Pending {
  readonly key: string;
  readonly name: string;
  readonly mime: string;
  readonly preview: string | null;
  readonly ref: AttachmentRef | null;
  readonly error: string | null;
}

/** Files added to the message box: uploaded right away, sent with the message as refs. */
export function useAttachments(sessionId: SessionId) {
  const [items, setItems] = useState<ReadonlyArray<Pending>>([]);

  const add = useCallback(
    (files: ReadonlyArray<File>) => {
      for (const file of files) {
        const key = `${file.name}-${file.size}-${Math.random()}`;
        const preview = isImage(file.type) ? URL.createObjectURL(file) : null;
        const update = (patch: Partial<Pending>) => setItems((all) => all.map((i) => (i.key === key ? { ...i, ...patch } : i)));
        setItems((all) => [...all, { key, name: file.name || "pasted file", mime: file.type, preview, ref: null, error: null }]);
        if (file.size > MAX_BYTES) {
          update({ error: "Larger than 25 MB" });
          continue;
        }
        fetch(`/api/attachments/${sessionId}?name=${encodeURIComponent(file.name || "pasted-file")}`, {
          method: "POST",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        })
          .then(async (response) => {
            if (!response.ok) throw new Error((await response.text()) || `Upload failed (${response.status})`);
            update({ ref: (await response.json()) as AttachmentRef });
          })
          .catch((error: unknown) => update({ error: error instanceof Error ? error.message : String(error) }));
      }
    },
    [sessionId],
  );

  const remove = (key: string) =>
    setItems((all) => {
      const gone = all.find((i) => i.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return all.filter((i) => i.key !== key);
    });

  const clear = () =>
    setItems((all) => {
      for (const i of all) if (i.preview) URL.revokeObjectURL(i.preview);
      return [];
    });

  return {
    items,
    add,
    remove,
    clear,
    uploading: items.some((i) => i.ref === null && i.error === null),
    refs: items.flatMap((i) => (i.ref ? [i.ref] : [])),
  };
}

/** The files waiting in the message box. */
export function PendingAttachments({ items, onRemove }: { items: ReadonlyArray<Pending>; onRemove: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {items.map((item) => (
        <div
          key={item.key}
          title={item.error ?? item.name}
          className={cx(
            "group animate-pop-in relative flex h-14 items-center gap-2 overflow-hidden rounded-lg border text-xs",
            item.error ? "border-red-900/60 bg-red-950/30" : "border-zinc-700/80 bg-zinc-800/60",
            item.preview ? "w-14" : "max-w-56 pr-7 pl-2.5",
          )}
        >
          {item.preview ? (
            <img src={item.preview} alt="" className="size-full object-cover" />
          ) : (
            <>
              <FileText className="size-4 shrink-0 text-zinc-400" />
              <span className="min-w-0">
                <span className="block truncate text-zinc-200">{item.name}</span>
                <span className={cx("block truncate text-[10px]", item.error ? "text-red-300" : "text-zinc-500")}>
                  {item.error ?? (item.ref ? size(item.ref.size) : "Uploading…")}
                </span>
              </span>
            </>
          )}
          {item.ref === null && item.error === null ? (
            <span className="absolute inset-0 flex items-center justify-center bg-black/40">
              <Loader2 className="size-4 animate-spin text-white" />
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => onRemove(item.key)}
            aria-label={`Remove ${item.name}`}
            className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X className="size-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Attachments shown on a sent message: image thumbnails and file chips. */
export function MessageAttachments({ sessionId, attachments }: { sessionId: SessionId; attachments: ReadonlyArray<AttachmentRef> }) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {attachments.map((a) =>
        isImage(a.mime) ? (
          <a key={a.id} href={attachmentUrl(sessionId, a.id)} target="_blank" rel="noreferrer" title={a.name}>
            <img
              src={attachmentUrl(sessionId, a.id)}
              alt={a.name}
              className="h-24 max-w-48 rounded-xl border border-zinc-800 object-cover transition-opacity hover:opacity-90"
            />
          </a>
        ) : (
          <a
            key={a.id}
            href={attachmentUrl(sessionId, a.id)}
            download={a.name}
            className="flex max-w-56 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs transition-colors hover:border-zinc-700"
          >
            <FileText className="size-4 shrink-0 text-zinc-400" />
            <span className="min-w-0">
              <span className="block truncate text-zinc-200">{a.name}</span>
              <span className="block text-[10px] text-zinc-500">{size(a.size)}</span>
            </span>
          </a>
        ),
      )}
    </div>
  );
}
