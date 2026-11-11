import { type PendingPairing, pairingQrPayload, type RemoteAccess, TAILSCALE_DNS_ADMIN_URL } from "@apollo/contracts";
import { ExternalLink, KeyRound, Loader2, LogIn, LogOut, QrCode, RefreshCw, ShieldCheck, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { errorMessage, rpc } from "../rpc.ts";
import { Button, ErrorText, Toggle } from "./ui.tsx";

const pendingPairings = async (): Promise<ReadonlyArray<PendingPairing>> => {
  const response = await fetch("/api/auth/pairing/pending", { credentials: "same-origin" });
  return response.ok ? ((await response.json()) as ReadonlyArray<PendingPairing>) : [];
};

const decide = (id: string, approve: boolean) =>
  fetch("/api/auth/pairing/decide", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, approve }),
  });

/**
 * Pairing the Apollo phone app: publish Apollo to the user's tailnet (HTTPS, tailnet only)
 * and show a QR code with the address, this computer's tailnet identity and a one-time
 * pairing token. A device that scans it still has to be allowed here.
 */
export function PhonePairing({ onPaired }: { onPaired: () => void }) {
  const [remote, setRemote] = useState<RemoteAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<{ image: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlyArray<PendingPairing>>([]);

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

  // Until Apollo's node is signed in and published, follow it (the sign-in happens in the browser).
  const waiting = remote?.enabled === true && remote.url === null && remote.tailscale !== "missing";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void rpc((c) => c["remote.status"]()).then(setRemote, () => undefined), 2000);
    return () => clearInterval(timer);
  }, [waiting]);

  const signOut = () => {
    setBusy(true);
    setError(null);
    setQr(null);
    rpc((c) => c["remote.signOutTailscale"]())
      .then(setRemote)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  const showCode = () => {
    if (!remote?.url) return;
    setError(null);
    rpc((c) => c["auth.createPairingToken"]({ label: "", phone: true }))
      .then(async (token) => {
        const pin = remote.nodeId && remote.userId ? { nodeId: remote.nodeId, userId: remote.userId } : undefined;
        const image = await QRCode.toDataURL(pairingQrPayload(remote.url!, token.token, pin), {
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

  // Devices that scanned a code wait here for an answer.
  useEffect(() => {
    if (!remote?.enabled) return;
    const poll = () => void pendingPairings().then(setPending, () => setPending([]));
    poll();
    const timer = setInterval(poll, 1500);
    return () => clearInterval(timer);
  }, [remote?.enabled]);

  const answer = (request: PendingPairing, approve: boolean) => {
    setPending((list) => list.filter((p) => p.id !== request.id));
    void decide(request.id, approve).then(() => {
      if (approve) {
        setQr(null);
        onPaired();
      }
    });
  };

  if (!remote) return null;
  return (
    <div className="space-y-3 border-t border-zinc-800/80 pt-5">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
        <Smartphone className="size-4 text-zinc-400" /> Pair a phone
      </div>
      {remote.tailscale === "missing" ? (
        <p className="text-xs leading-relaxed text-zinc-500">
          The Apollo phone app connects over Tailscale, which this build of Apollo does not include.
        </p>
      ) : (
        <>
          <Toggle
            checked={remote.enabled}
            onChange={toggle}
            label="Reach Apollo over Tailscale"
            description={
              remote.enabled && remote.url
                ? `Published at ${remote.url}${remote.loginName ? ` on ${remote.loginName}'s tailnet` : ""}. Only devices signed in to Tailscale as you can connect, and each still has to pair.`
                : "Apollo joins your tailnet as its own machine and publishes itself there over HTTPS. The Tailscale app does not need to be on, other VPNs keep working, and nothing is opened to the internet."
            }
          />
          {busy ? <Loader2 className="size-4 animate-spin text-zinc-500" /> : null}
          {remote.enabled && remote.tailscale === "needs-login" ? (
            <div className="space-y-2 rounded-xl border border-sky-700/40 bg-sky-950/20 p-3 text-xs leading-relaxed text-zinc-300">
              <p>Sign Apollo in to Tailscale with the same account as your phone. It shows up in your tailnet as its own machine.</p>
              {remote.loginUrl ? (
                <a href={remote.loginUrl} target="_blank" rel="noreferrer">
                  <Button size="sm">
                    <LogIn /> Sign in to Tailscale
                  </Button>
                </a>
              ) : (
                <span className="flex items-center gap-1.5 text-zinc-500">
                  <Loader2 className="size-3 animate-spin" /> Getting a sign-in link…
                </span>
              )}
            </div>
          ) : null}
          {remote.enabled && remote.tailscale === "running" && remote.needsHttps ? (
            <div className="space-y-2 rounded-xl border border-sky-700/40 bg-sky-950/20 p-3 text-xs leading-relaxed text-zinc-300">
              <p className="font-medium text-zinc-100">One more step: turn on HTTPS for your tailnet</p>
              <p>
                Apollo is on your tailnet, but it needs an HTTPS certificate so your phone can connect securely, and new
                Tailscale accounts start with certificates turned off.
              </p>
              <ol className="list-decimal space-y-0.5 pl-4">
                <li>Open the DNS page of your tailnet's admin console.</li>
                <li>
                  Turn on <span className="font-medium text-zinc-100">MagicDNS</span> if it is off.
                </li>
                <li>
                  Under <span className="font-medium text-zinc-100">HTTPS Certificates</span>, click{" "}
                  <span className="font-medium text-zinc-100">Enable HTTPS</span>.
                </li>
              </ol>
              <a href={TAILSCALE_DNS_ADMIN_URL} target="_blank" rel="noreferrer" className="inline-block">
                <Button size="sm">
                  <ExternalLink /> Open Tailscale DNS settings
                </Button>
              </a>
              <p className="flex items-center gap-1.5 text-zinc-500">
                <Loader2 className="size-3 animate-spin" /> Apollo gets its certificate as soon as HTTPS is on: no need to come back here.
              </p>
            </div>
          ) : null}
          {remote.enabled && remote.tailscale === "running" && !remote.url && !remote.needsHttps && !remote.error ? (
            <p className="flex items-center gap-1.5 text-xs text-zinc-500">
              <Loader2 className="size-3 animate-spin" /> Getting Apollo's HTTPS certificate (about half a minute)…
            </p>
          ) : null}
          {remote.enabled && remote.tailscale === "starting" ? (
            <p className="flex items-center gap-1.5 text-xs text-zinc-500">
              <Loader2 className="size-3 animate-spin" /> Connecting to your tailnet…
            </p>
          ) : null}
          {pending.map((request) => (
            <div key={request.id} className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                <ShieldCheck className="size-4 text-amber-300" /> Allow “{request.label}” to use Apollo?
              </div>
              <p className="text-xs leading-relaxed text-zinc-400">
                Tailscale says this is <span className="font-mono text-zinc-200">{request.nodeName}</span>
                {request.os ? ` (${request.os})` : ""}, signed in as {request.loginName || "you"}.{" "}
                {request.deviceKey ? (
                  <span className="inline-flex items-center gap-1 text-emerald-300">
                    <KeyRound className="size-3" /> Its requests are signed by a key that never leaves it.
                  </span>
                ) : null}{" "}
                Only allow it if you just scanned the code yourself.
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => answer(request, true)}>
                  Allow
                </Button>
                <Button size="sm" variant="ghost" onClick={() => answer(request, false)}>
                  Deny
                </Button>
              </div>
            </div>
          ))}
          {remote.enabled && remote.url ? (
            qr ? (
              <div className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-3">
                <img src={qr.image} alt="Pairing QR code" className="size-40 rounded-lg" />
                <div className="space-y-2 text-xs text-zinc-400">
                  <p>
                    Open the Apollo app on your phone and scan this code, then allow the phone here. The app brings its
                    own Tailscale connection; the Tailscale app is not needed on the phone.
                  </p>
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
          {remote.loginName && remote.tailscale !== "stopped" ? (
            <p className="flex items-center gap-2 text-[11px] text-zinc-500">
              Apollo's Tailscale node is signed in as {remote.loginName}.
              <button type="button" className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200" onClick={signOut}>
                <LogOut className="size-3" /> Sign out
              </button>
            </p>
          ) : null}
        </>
      )}
      <ErrorText>{error ?? remote.error}</ErrorText>
    </div>
  );
}
