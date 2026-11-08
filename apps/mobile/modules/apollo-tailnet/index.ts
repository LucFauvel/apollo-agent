import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/** Tailscale ipn.State string: "NoState", "NeedsLogin", "NeedsMachineAuth", "Starting", "Running", "Stopped". */
export type TailnetState = string;

export interface TailnetStatus {
  state: TailnetState;
  authUrl: string | null;
  nodeId: string | null;
  userId: string | null;
  loginName: string | null;
  dnsName: string | null;
}

interface NativeApolloTailnet {
  tailnetStart(): Promise<TailnetStatus>;
  tailnetStatus(): Promise<TailnetStatus>;
  tailnetStop(): Promise<void>;
  tailnetLogout(): Promise<void>;
  tailnetForward(host: string, port: number, expectedNodeId: string, expectedUserId: string): Promise<{ localPort: number }>;
  tailnetStopForward(): Promise<void>;
  deviceKeyPublic(): Promise<{ publicKey: string; hardware: boolean }>;
  deviceKeySign(message: string): Promise<string>;
  deviceKeyDelete(): Promise<void>;
}

// iOS only. Android, web and Expo Go have no such module.
const native: NativeApolloTailnet | null =
  Platform.OS === "ios" ? requireOptionalNativeModule<NativeApolloTailnet>("ApolloTailnet") : null;

export const isAvailable: boolean = native !== null;

function mod(): NativeApolloTailnet {
  if (!native) throw new Error("ApolloTailnet is not available on this platform");
  return native;
}

const call = <T>(fn: (m: NativeApolloTailnet) => Promise<T>): Promise<T> => {
  try {
    return fn(mod());
  } catch (error) {
    return Promise.reject(error);
  }
};

/** Starts the embedded Tailscale node (no system VPN). Resolves once control gave a login URL or the node runs (≤10 s). */
export function tailnetStart(): Promise<TailnetStatus> {
  return call((m) => m.tailnetStart());
}

/** Current state; requests a fresh login URL if the node needs login and has none. */
export function tailnetStatus(): Promise<TailnetStatus> {
  return call((m) => m.tailnetStatus());
}

/** Stops the node and any forwarder, keeping the login. */
export function tailnetStop(): Promise<void> {
  return call((m) => m.tailnetStop());
}

/** Logs the node out, stops it and deletes its state. */
export function tailnetLogout(): Promise<void> {
  return call((m) => m.tailnetLogout());
}

/**
 * Opens http://127.0.0.1:<localPort> that tunnels to host:port over the tailnet, TLS
 * verified for `host`, and only if the peer is node `expectedNodeId` owned by user
 * `expectedUserId` (decimal), untagged and not shared in. Idempotent for the same
 * arguments; other arguments replace the previous forwarder.
 */
export function tailnetForward(
  host: string,
  port: number,
  expectedNodeId: string,
  expectedUserId: string,
): Promise<{ localPort: number }> {
  return call((m) => m.tailnetForward(host, port, expectedNodeId, expectedUserId));
}

export function tailnetStopForward(): Promise<void> {
  return call((m) => m.tailnetStopForward());
}

/** Creates the device key if missing. publicKey: base64url (no padding) of the 65-byte uncompressed P-256 point. */
export function deviceKeyPublic(): Promise<{ publicKey: string; hardware: boolean }> {
  return call((m) => m.deviceKeyPublic());
}

/** ECDSA P-256 / SHA-256 over the UTF-8 message; base64url DER signature. */
export function deviceKeySign(message: string): Promise<string> {
  return call((m) => m.deviceKeySign(message));
}

export function deviceKeyDelete(): Promise<void> {
  return call((m) => m.deviceKeyDelete());
}
