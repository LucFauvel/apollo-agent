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

/** Where this phone is paired: the Apollo server (over Tailscale) and its session token. */
export interface Pairing {
  readonly server: string;
  readonly token: string;
}

const SERVER_KEY = "apollo.server";
const TOKEN_KEY = "apollo.token";

export const loadPairing = async (): Promise<Pairing | null> => {
  const [server, token] = await Promise.all([SecureStore.getItemAsync(SERVER_KEY), SecureStore.getItemAsync(TOKEN_KEY)]);
  return server && token ? { server, token } : null;
};

export const forgetPairing = () => Promise.all([SecureStore.deleteItemAsync(SERVER_KEY), SecureStore.deleteItemAsync(TOKEN_KEY)]);

/** `apollo://pair?server=<url>&token=<one-time token>` (the QR code on the computer). */
export const parsePairingCode = (text: string): { server: string; token: string } | null => {
  try {
    const url = new URL(text.trim());
    if (url.protocol !== "apollo:") return null;
    const server = url.searchParams.get("server");
    const token = url.searchParams.get("token");
    if (!server || !token || !/^https?:\/\//.test(server)) return null;
    return { server: server.replace(/\/+$/, ""), token };
  } catch {
    return null;
  }
};

/** Trades the one-time pairing token for a long-lived session token, and stores it securely. */
export const pair = async (server: string, pairingToken: string): Promise<Pairing> => {
  const response = await fetch(`${server}/api/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: pairingToken,
      label: `${Platform.OS === "ios" ? "iPhone" : "Android phone"} (Apollo app)`,
      bearer: true,
    }),
  }).catch(() => {
    throw new Error(`Could not reach ${server}. Is Tailscale on, on this phone and on the computer?`);
  });
  const body = (await response.json().catch(() => ({}))) as { sessionToken?: string | null; error?: string };
  if (!response.ok || !body.sessionToken) throw new Error(body.error ?? `Pairing failed (${response.status})`);
  await Promise.all([SecureStore.setItemAsync(SERVER_KEY, server), SecureStore.setItemAsync(TOKEN_KEY, body.sessionToken)]);
  return { server, token: body.sessionToken };
};

const makeClient = RpcClient.make(ApolloRpcs);
export type ApolloClient = Effect.Success<typeof makeClient>;
class Client extends Context.Service<Client, ApolloClient>()("apollo/mobile/Client") {}

/**
 * The typed RPC connection to Apollo, over a WebSocket that carries the session token.
 * React Native's WebSocket takes headers as a third argument (browsers' cannot).
 */
export const connect = (pairing: Pairing) => {
  const url = `${pairing.server.replace(/^http/, "ws")}/rpc`;
  const WebSocketWithAuth = (wsUrl: string) =>
    new (WebSocket as unknown as new (u: string, p: undefined, o: { headers: Record<string, string> }) => WebSocket)(wsUrl, undefined, {
      headers: { Authorization: `Bearer ${pairing.token}` },
    }) as unknown as Socket.WebSocketLike;
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

  return { rpc, follow, dispose: () => runtime.dispose() };
};

export type Connection = ReturnType<typeof connect>;

export const errorMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : String(error);
