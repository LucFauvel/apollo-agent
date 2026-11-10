import { ApolloRpcs } from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { devicePublicKey, holdRoute, makeProofPool, proofFor, routeTo, type ServerPin } from "./tailnet.ts";

/**
 * Where this phone is paired: the Apollo server's tailnet URL, its session token, and the
 * computer's tailnet identity (from the QR code), which the app's own tailnet node checks.
 */
export interface Pairing {
  readonly server: string;
  readonly token: string;
  readonly pin: ServerPin | null;
}

const SERVER_KEY = "apollo.server";
const TOKEN_KEY = "apollo.token";
const PIN_KEY = "apollo.pin";

export const loadPairing = async (): Promise<Pairing | null> => {
  const [server, token, pin] = await Promise.all([
    SecureStore.getItemAsync(SERVER_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(PIN_KEY),
  ]);
  return server && token ? { server, token, pin: pin ? (JSON.parse(pin) as ServerPin) : null } : null;
};

export const forgetPairing = () =>
  Promise.all([SecureStore.deleteItemAsync(SERVER_KEY), SecureStore.deleteItemAsync(TOKEN_KEY), SecureStore.deleteItemAsync(PIN_KEY)]);

export interface PairingCode {
  readonly server: string;
  readonly token: string;
  readonly pin: ServerPin | null;
}

/** `apollo://pair?server=<url>&token=<one-time token>&node=<StableID>&user=<user ID>` (the QR code on the computer). */
export const parsePairingCode = (text: string): PairingCode | null => {
  try {
    const url = new URL(text.trim());
    if (url.protocol !== "apollo:") return null;
    const server = url.searchParams.get("server");
    const token = url.searchParams.get("token");
    if (!server || !token || !/^https?:\/\//.test(server)) return null;
    const nodeId = url.searchParams.get("node");
    const userId = url.searchParams.get("user");
    return { server: server.replace(/\/+$/, ""), token, pin: nodeId && userId ? { nodeId, userId } : null };
  } catch {
    return null;
  }
};

/**
 * Trades the one-time pairing token for a long-lived session token, and stores it securely.
 * The request registers this phone's device key, signed with it, and waits until someone
 * allows the phone on the computer.
 */
export const pair = (code: PairingCode): Promise<Pairing> =>
  // Backgrounding the app must not drop the relay mid-request: the server spends the
  // one-time token on arrival, so a cut request could not be retried with the same code.
  holdRoute(() => pairOnce(code));

const pairOnce = async (code: PairingCode): Promise<Pairing> => {
  const { server, pin } = code;
  const base = await routeTo(server, pin);
  const deviceKey = await devicePublicKey();
  const proof = deviceKey ? await proofFor("POST", "/api/auth/pair") : null;
  const response = await fetch(`${base}/api/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(proof ? { "x-apollo-proof": proof } : {}) },
    body: JSON.stringify({
      token: code.token,
      label: `${Platform.OS === "ios" ? "iPhone" : "Android phone"} (Apollo app)`,
      bearer: true,
      ...(deviceKey ? { deviceKey } : {}),
    }),
  }).catch(() => {
    throw new Error(
      base === server
        ? `Could not reach ${server}. Sign in to Tailscale in Apollo (or turn on the Tailscale app), and check the computer is online.`
        : `Could not reach the computer over Tailscale. Is it online, with Apollo running?`,
    );
  });
  const body = (await response.json().catch(() => ({}))) as { sessionToken?: string | null; error?: string };
  if (!response.ok || !body.sessionToken) throw new Error(body.error ?? `Pairing failed (${response.status})`);
  await Promise.all([
    SecureStore.setItemAsync(SERVER_KEY, server),
    SecureStore.setItemAsync(TOKEN_KEY, body.sessionToken),
    pin ? SecureStore.setItemAsync(PIN_KEY, JSON.stringify(pin)) : SecureStore.deleteItemAsync(PIN_KEY),
  ]);
  return { server, token: body.sessionToken, pin };
};

/** An authenticated, signed HTTP request to Apollo (`path` starts with `/api/`). */
export const apiFetch = async (
  pairing: Pairing,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => {
  const base = await routeTo(pairing.server, pairing.pin);
  // The server checks the proof against the path without its query.
  const proof = await proofFor(init.method, path.split("?")[0]!);
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${pairing.token}`,
      ...(proof ? { "x-apollo-proof": proof } : {}),
    },
  });
};

/** What `connect` needs that takes a moment: the route (the app's tailnet relay) and a signed proof. */
export interface Route {
  readonly base: string;
  readonly proofs: ReturnType<typeof makeProofPool>;
}

export const prepareRoute = async (pairing: Pairing): Promise<Route> => {
  // No fallback to the plain URL: routeTo refuses anything but the pinned computer.
  const base = await routeTo(pairing.server, pairing.pin);
  const proofs = makeProofPool("GET", "/rpc");
  await proofs.fill();
  return { base, proofs };
};

const makeClient = RpcClient.make(ApolloRpcs);
export type ApolloClient = Effect.Success<typeof makeClient>;
class Client extends Context.Service<Client, ApolloClient>()("apollo/mobile/Client") {}

/**
 * The typed RPC connection to Apollo, over a WebSocket that carries the session token and
 * a device-key proof. React Native's WebSocket takes headers as a third argument
 * (browsers' cannot).
 */
export const connect = (pairing: Pairing, route: Route) => {
  const url = `${route.base.replace(/^http/, "ws")}/rpc`;
  const WebSocketWithAuth = (wsUrl: string) => {
    const proof = route.proofs.take();
    return new (WebSocket as unknown as new (u: string, p: undefined, o: { headers: Record<string, string> }) => WebSocket)(wsUrl, undefined, {
      headers: { Authorization: `Bearer ${pairing.token}`, ...(proof ? { "x-apollo-proof": proof } : {}) },
    }) as unknown as Socket.WebSocketLike;
  };
  const layer = Layer.effect(Client, makeClient).pipe(
    Layer.provide(
      // Phones lose the route often (Tailscale waking up, Wi-Fi to cellular): give up on a
      // silent socket quickly and retry every second, instead of 10 s timeouts and backoff.
      RpcClient.layerProtocolSocket({ retryTransientErrors: true, retryPolicy: Schedule.spaced("1 second") }).pipe(
        Layer.provide(Socket.layerWebSocket(url, { openTimeout: "4 seconds" })),
        Layer.provide(Layer.succeed(Socket.WebSocketConstructor, WebSocketWithAuth)),
        Layer.provide(RpcSerialization.layerJson),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(layer);

  const rpc = <A, E>(f: (client: ApolloClient) => Effect.Effect<A, E>): Promise<A> => runtime.runPromise(Effect.flatMap(Client, f));

  /** Follows a streaming RPC, restarting it after failures (server restarts, network changes). */
  const follow = <A, E>(open: (client: ApolloClient) => Stream.Stream<A, E>, onItem: (item: A) => void, onError?: () => void) => {
    const fiber = runtime.runFork(
      Effect.flatMap(Client, (client) =>
        Stream.runForEach(
          Stream.suspend(() => open(client)),
          (item) => Effect.sync(() => onItem(item)),
        ),
      ).pipe(
        Effect.tapCause(() => Effect.sync(() => onError?.())),
        Effect.retry(Schedule.spaced("1 second")),
      ),
    );
    return () => void runtime.runFork(Fiber.interrupt(fiber));
  };

  return {
    rpc,
    follow,
    dispose: () => {
      route.proofs.dispose();
      return runtime.dispose();
    },
  };
};

export type Connection = ReturnType<typeof connect>;

export const errorMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : String(error);
