import type { AuthStatus, PairedClient, PairingToken } from "@apollo/contracts";
import { Copy, Laptop, Link2, MonitorSmartphone, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { signOut } from "../auth.tsx";
import { errorMessage, rpc } from "../rpc.ts";
import { PhonePairing } from "./PhonePairing.tsx";
import { Badge, Button, ErrorText, Field, inputClass, Modal } from "./ui.tsx";

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
      description="Devices paired with this Apollo server."
      icon={
        <span className="flex size-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
          <MonitorSmartphone className="size-4.5 text-zinc-400" strokeWidth={1.75} />
        </span>
      }
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-1.5">
        {clients.map((client) => (
          <div key={client.id} className="flex items-center gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-3 py-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-400">
              {/iPhone|iOS|Android/i.test(client.label) ? <Smartphone className="size-4" /> : <Laptop className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 truncate text-sm text-zinc-100">
                {client.label}
                {client.id === current ? <Badge tone="emerald">This device</Badge> : null}
              </div>
              <div className="text-[11px] text-zinc-500">
                {client.method === "desktop" ? "Desktop app" : client.nodeName ? `Only from ${client.nodeName}` : "Pairing link"}
                {client.deviceKey ? " · device key" : ""} · active {ago(client.lastSeenAt)}
              </div>
            </div>
            <Button size="sm" variant={client.id === current ? "ghost" : "danger"} onClick={() => revoke(client)}>
              {client.id === current ? "Sign out" : "Revoke"}
            </Button>
          </div>
        ))}
      </div>

      <PhonePairing onPaired={refresh} />

      <div className="space-y-2 border-t border-zinc-800/80 pt-5">
        <Field label="Pair another device" hint="Creates a one-time link that expires in 10 minutes.">
          <div className="flex gap-2">
            <input
              className={inputClass}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Name (optional), e.g. Work laptop"
            />
            <Button className="shrink-0 whitespace-nowrap" onClick={createLink}>
              <Link2 /> Create link
            </Button>
          </div>
        </Field>
        {link ? (
          <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900 p-3">
            <code className="block font-mono text-[11px] break-all text-zinc-300">{link.url}</code>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void navigator.clipboard.writeText(link.url).then(() => setCopied(true))}
              >
                <Copy /> {copied ? "Copied" : "Copy link"}
              </Button>
              <span className="text-[11px] text-zinc-500">
                Expires at {new Date(link.expiresAt).toLocaleTimeString()}. Anyone with this link can pair once.
              </span>
            </div>
          </div>
        ) : null}
      </div>
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}
