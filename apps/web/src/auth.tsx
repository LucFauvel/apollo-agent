import type { AuthStatus, PairResponse } from "@apollo/contracts";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button, inputClass } from "./components/ui.tsx";

const fetchStatus = async (): Promise<AuthStatus> => {
  const response = await fetch("/api/auth/session", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Apollo server answered ${response.status}`);
  return (await response.json()) as AuthStatus;
};

/** Redeems a pairing token; on success the server sets the session cookie. */
export const redeemPairingToken = async (token: string, label: string): Promise<PairResponse> => {
  const response = await fetch("/api/auth/pair", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, label }),
  });
  const body = (await response.json()) as PairResponse | { error: string };
  if (!response.ok || "error" in body) {
    throw new Error("error" in body ? body.error : `Pairing failed (${response.status})`);
  }
  return body;
};

export const signOut = async () => {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  window.location.reload();
};

/** Accepts a full pairing link (`…/pair#token=…`) or a bare token. */
const tokenFrom = (input: string): string => {
  const trimmed = input.trim();
  const match = /[#&?]token=([^&\s]+)/.exec(trimmed);
  return match ? decodeURIComponent(match[1]!) : trimmed;
};

const defaultLabel = () => {
  const ua = navigator.userAgent;
  const browser = /Electron/.test(ua) ? "Apollo Desktop" : /Firefox/.test(ua) ? "Firefox" : /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Browser";
  const os = /Mac/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
};

function PairScreen({ initialError, onPaired }: { initialError: string | null; onPaired: () => void }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  const pair = () => {
    setBusy(true);
    setError(null);
    redeemPairingToken(tokenFrom(input), defaultLabel())
      .then(onPaired)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-200">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-zinc-800 bg-zinc-950 p-6">
        <div>
          <div className="text-lg font-semibold text-zinc-100">Pair this device</div>
          <p className="mt-1 text-sm text-zinc-400">
            Apollo only accepts paired devices. Open a pairing link, or paste one here. To get a link, run{" "}
            <code className="rounded bg-zinc-800 px-1 font-mono text-xs">apollo pair</code> on the machine running
            Apollo, check its log on first start, or use <span className="text-zinc-300">Devices</span> on a device
            that is already paired.
          </p>
        </div>
        <input
          className={inputClass}
          value={input}
          autoFocus
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && input.trim() && pair()}
          placeholder="http://127.0.0.1:4317/pair#token=…"
        />
        {error ? <div className="text-xs text-red-400">{error}</div> : null}
        <Button variant="primary" className="w-full" disabled={!input.trim() || busy} onClick={pair}>
          Pair
        </Button>
      </div>
    </div>
  );
}

type Gate =
  | { readonly state: "checking" }
  | { readonly state: "unpaired"; readonly error: string | null }
  | { readonly state: "paired" }
  | { readonly state: "offline"; readonly error: string };

/**
 * Renders `children` only for a paired device. Handles `/pair#token=…` links,
 * and re-checks periodically so a revoked device drops back to the pairing screen.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>({ state: "checking" });

  const check = useCallback(async () => {
    try {
      const status = await fetchStatus();
      setGate((current) =>
        status.authenticated
          ? { state: "paired" }
          : current.state === "unpaired"
            ? current
            : { state: "unpaired", error: current.state === "paired" ? "This device was signed out or revoked." : null },
      );
    } catch (e) {
      setGate((current) => (current.state === "paired" ? current : { state: "offline", error: (e as Error).message }));
    }
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const token = url.pathname === "/pair" ? new URLSearchParams(url.hash.slice(1)).get("token") : null;
    const label = new URLSearchParams(url.hash.slice(1)).get("label");
    // Drop the secret from the address bar and history straight away.
    if (url.pathname === "/pair") window.history.replaceState(null, "", "/");
    if (token) {
      // Already paired (e.g. the desktop app relaunching): keep the existing session.
      fetchStatus()
        .then((status) => (status.authenticated ? undefined : redeemPairingToken(token, label ?? defaultLabel())))
        .then(() => setGate({ state: "paired" }))
        .catch((e: Error) => setGate({ state: "unpaired", error: e.message }));
    } else {
      void check();
    }
    const interval = window.setInterval(() => void check(), 30_000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [check]);

  switch (gate.state) {
    case "checking":
      return <div className="h-screen bg-zinc-950" />;
    case "offline":
      return (
        <div className="flex h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-400">
          Cannot reach the Apollo server: {gate.error}
        </div>
      );
    case "unpaired":
      return <PairScreen initialError={gate.error} onPaired={() => setGate({ state: "paired" })} />;
    case "paired":
      return <>{children}</>;
  }
}
