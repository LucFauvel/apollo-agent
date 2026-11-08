import { deviceProofMessage } from "@apollo/contracts";
import * as Native from "../modules/apollo-tailnet";

/**
 * The phone's own way onto the tailnet and its device key, both from the native
 * `apollo-tailnet` module:
 *
 * - The app runs its own Tailscale node (signed in to the user's account), so the
 *   Tailscale app and its VPN are not needed on the phone. Requests go to a relay on the
 *   phone's loopback, which carries them over that node to the paired computer, after
 *   checking with Tailscale that the other end is that exact computer.
 * - A key in the Secure Enclave signs every request (`x-apollo-proof`), so a copied
 *   session token is useless without this phone.
 *
 * Where the module is missing (Android, Expo Go), Apollo falls back to the system's
 * Tailscale and plain bearer tokens.
 */
export const tailnetAvailable = Native.isAvailable;
export type TailnetStatus = Native.TailnetStatus;

export const startTailnet = (): Promise<TailnetStatus | null> =>
  tailnetAvailable ? Native.tailnetStart() : Promise.resolve(null);

export const tailnetStatus = (): Promise<TailnetStatus | null> =>
  tailnetAvailable ? Native.tailnetStatus() : Promise.resolve(null);

export const signOutOfTailnet = () => (tailnetAvailable ? Native.tailnetLogout() : Promise.resolve());

/** The computer's tailnet identity, pinned from the pairing QR code. */
export interface ServerPin {
  readonly nodeId: string;
  readonly userId: string;
}

/**
 * The base URL to reach Apollo at: the loopback relay through the app's own tailnet node,
 * which only connects to the pinned computer. Fails closed: with a pin, Apollo is never
 * reached any other way (a server that took over the hostname, with a valid certificate,
 * would otherwise get the session token). Without the native module (Android, Expo Go)
 * a pin cannot be checked, and the system's Tailscale route is used.
 */
export const routeTo = async (server: string, pin: ServerPin | null): Promise<string> => {
  if (!tailnetAvailable || !pin) return server;
  const status = await Native.tailnetStart().catch(() => null);
  if (status?.state !== "Running") {
    throw new Error(status?.state === "NeedsLogin" ? "Apollo's Tailscale connection is signed out." : "Apollo's Tailscale connection is not ready yet.");
  }
  const url = new URL(server);
  const { localPort } = await Native.tailnetForward(url.hostname, Number(url.port || 443), pin.nodeId, pin.userId);
  return `http://127.0.0.1:${localPort}`;
};

// --- device key ----------------------------------------------------------

let publicKey: Promise<string | null> | null = null;

/** This phone's device public key, created on first use; null where there is no key store. */
export const devicePublicKey = (): Promise<string | null> => {
  if (!tailnetAvailable) return Promise.resolve(null);
  publicKey ??= Native.deviceKeyPublic()
    .then((key) => key.publicKey)
    .catch(() => null);
  return publicKey;
};

export const forgetDeviceKey = async () => {
  publicKey = null;
  if (tailnetAvailable) await Native.deviceKeyDelete().catch(() => undefined);
};

/** Only uniqueness matters: the server refuses a nonce it has seen. */
const nonce = () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < 24; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
};

/** `x-apollo-proof` for one request, or null without a device key. */
export const proofFor = async (method: string, path: string): Promise<string | null> => {
  if ((await devicePublicKey()) === null) return null;
  const timestamp = String(Date.now());
  const n = nonce();
  const signature = await Native.deviceKeySign(deviceProofMessage(method, path, timestamp, n));
  return `${timestamp}.${n}.${signature}`;
};

/**
 * Proofs for WebSocket (re)connections, whose constructor is synchronous: one signed
 * proof is kept ready and replaced after each use and before it gets stale.
 */
export const makeProofPool = (method: string, path: string) => {
  let ready: { proof: string; at: number } | null = null;
  let filling: Promise<void> | null = null;
  const fill = () => {
    filling ??= proofFor(method, path)
      .then((proof) => void (ready = proof ? { proof, at: Date.now() } : null))
      .catch(() => void (ready = null))
      .finally(() => void (filling = null));
    return filling;
  };
  const timer = setInterval(() => void fill(), 45_000);
  return {
    fill,
    take: (): string | null => {
      const current = ready;
      ready = null;
      void fill();
      return current && Date.now() - current.at < 90_000 ? current.proof : null;
    },
    dispose: () => clearInterval(timer),
  };
};
