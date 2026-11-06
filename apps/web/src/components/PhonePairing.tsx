import { pairingQrPayload, type RemoteAccess } from "@apollo/contracts";
import { Loader2, QrCode, RefreshCw, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { errorMessage, rpc } from "../rpc.ts";
import { Button, ErrorText, Toggle } from "./ui.tsx";

/**
 * Pairing the Apollo phone app: publish Apollo to the user's tailnet (HTTPS, tailnet only)
 * and show a QR code with the address and a one-time pairing token.
 */
export function PhonePairing({ onPaired }: { onPaired: () => void }) {
  const [remote, setRemote] = useState<RemoteAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<{ image: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc((c) => c["remote.status"]())
      .then(setRemote)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const toggle = (enabled: boolean) => {
    setBusy(true);
    setError(null);
    setQr(null);
    rpc((c) => c["remote.setTailscale"]({ enabled }))
      .then(setRemote)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  const showCode = () => {
    if (!remote?.url) return;
    setError(null);
    rpc((c) => c["auth.createPairingToken"]({ label: "Phone" }))
      .then(async (token) => {
        const image = await QRCode.toDataURL(pairingQrPayload(remote.url!, token.token), {
          margin: 1,
          width: 220,
          color: { dark: "#09090b", light: "#ffffff" },
        });
        setQr({ image, expiresAt: token.expiresAt });
      })
      .catch((e) => setError(errorMessage(e)));
  };

  // A pairing link works once: refresh the device list while the code is up.
  useEffect(() => {
    if (!qr) return;
    const timer = setInterval(onPaired, 3000);
    return () => clearInterval(timer);
  }, [qr, onPaired]);

  if (!remote) return null;
  return (
    <div className="space-y-3 border-t border-zinc-800/80 pt-5">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
        <Smartphone className="size-4 text-zinc-400" /> Pair a phone
      </div>
      {remote.tailscale !== "running" ? (
        <p className="text-xs leading-relaxed text-zinc-500">
          The Apollo phone app connects over{" "}
          <a className="text-sky-300 hover:underline" href="https://tailscale.com/download" target="_blank" rel="noreferrer">
            Tailscale
          </a>
          , so your phone can reach this computer from anywhere without opening it to the internet.{" "}
          {remote.tailscale === "missing" ? "Install Tailscale here and on your phone, and sign in to both." : "Open Tailscale on this computer and sign in."}
        </p>
      ) : (
        <>
          <Toggle
            checked={remote.enabled}
            onChange={toggle}
            label="Reach Apollo over Tailscale"
            description={
              remote.enabled && remote.url
                ? `Published at ${remote.url}, for your own devices on your tailnet. Each device still has to pair.`
                : `Publishes Apollo on your tailnet (${remote.dnsName ?? "this machine"}) over HTTPS. Nothing is opened to the internet.`
            }
          />
          {busy ? <Loader2 className="size-4 animate-spin text-zinc-500" /> : null}
          {remote.enabled && remote.url ? (
            qr ? (
              <div className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-3">
                <img src={qr.image} alt="Pairing QR code" className="size-40 rounded-lg" />
                <div className="space-y-2 text-xs text-zinc-400">
                  <p>Open the Apollo app on your phone and scan this code. Tailscale must be on there too.</p>
                  <p className="text-[11px] text-zinc-500">
                    Works once, until {new Date(qr.expiresAt).toLocaleTimeString()}.
                  </p>
                  <Button size="sm" variant="ghost" onClick={showCode}>
                    <RefreshCw /> New code
                  </Button>
                </div>
              </div>
            ) : (
              <Button onClick={showCode}>
                <QrCode /> Show pairing QR code
              </Button>
            )
          ) : null}
        </>
      )}
      <ErrorText>{error ?? remote.error}</ErrorText>
    </div>
  );
}
