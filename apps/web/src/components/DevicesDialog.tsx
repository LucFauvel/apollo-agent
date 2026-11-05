import type { AuthStatus, PairedClient, PairingToken } from "@apollo/contracts";
import { useCallback, useEffect, useState } from "react";
import { signOut } from "../auth.tsx";
import { errorMessage, rpc } from "../rpc.ts";
import { Button, Field, inputClass, Modal } from "./ui.tsx";

const ago = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

/** Paired devices: list and revoke them, and create one-time pairing links. */
export function DevicesDialog({ onClose }: { onClose: () => void }) {
  const [clients, setClients] = useState<ReadonlyArray<PairedClient>>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [link, setLink] = useState<(PairingToken & { url: string }) | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    rpc((c) => c["auth.listClients"]())
      .then(setClients)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    refresh();
    void fetch("/api/auth/session")
      .then((r) => r.json() as Promise<AuthStatus>)
      .then((s) => setCurrent(s.clientId));
  }, [refresh]);

  const createLink = () => {
    setCopied(false);
    rpc((c) => c["auth.createPairingToken"]({ label: label.trim() }))
      .then((t) =>
        setLink({ ...t, url: `${window.location.origin}/pair#token=${encodeURIComponent(t.token)}` }),
      )
      .catch((e) => setError(errorMessage(e)));
  };

  const revoke = (client: PairedClient) => {
    if (client.id === current) return void signOut();
    if (!confirm(`Revoke "${client.label}"? It will need a new pairing link to reconnect.`)) return;
    rpc((c) => c["auth.revokeClient"]({ clientId: client.id }))
      .then(refresh)
      .catch((e) => setError(errorMessage(e)));
  };

  return (
    <Modal
      title="Devices"
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-1.5">
        {clients.map((client) => (
          <div key={client.id} className="flex items-center gap-3 rounded-md border border-zinc-800 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-zinc-100">
                {client.label}
                {client.id === current ? <span className="ml-2 text-[10px] text-emerald-400">this device</span> : null}
              </div>
              <div className="text-[11px] text-zinc-500">
                {client.method === "desktop" ? "Desktop app" : "Pairing link"} · active {ago(client.lastSeenAt)}
              </div>
            </div>
            <Button size="sm" variant={client.id === current ? "ghost" : "danger"} onClick={() => revoke(client)}>
              {client.id === current ? "Sign out" : "Revoke"}
            </Button>
          </div>
        ))}
      </div>

      <div className="space-y-2 border-t border-zinc-800 pt-4">
        <Field label="Pair another device" hint="Creates a one-time link that expires in 10 minutes.">
          <div className="flex gap-2">
            <input
              className={inputClass}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Name (optional), e.g. Work laptop"
            />
            <Button className="shrink-0 whitespace-nowrap" onClick={createLink}>
              Create link
            </Button>
          </div>
        </Field>
        {link ? (
          <div className="space-y-1.5 rounded-md border border-zinc-800 bg-zinc-900 p-2.5">
            <code className="block font-mono text-[11px] break-all text-zinc-300">{link.url}</code>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void navigator.clipboard.writeText(link.url).then(() => setCopied(true))}
              >
                {copied ? "Copied" : "Copy link"}
              </Button>
              <span className="text-[11px] text-zinc-500">
                Expires at {new Date(link.expiresAt).toLocaleTimeString()}. Anyone with this link can pair once.
              </span>
            </div>
          </div>
        ) : null}
      </div>
      {error ? <div className="text-xs text-red-400">{error}</div> : null}
    </Modal>
  );
}
