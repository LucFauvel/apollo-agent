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

const makeClient = RpcClient.make(ApolloRpcs);
export type ApolloClient = Effect.Success<typeof makeClient>;

class Client extends Context.Service<Client, ApolloClient>()("apollo/web/Client") {}

const rpcUrl = () => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/rpc`;
};

const layer = Layer.effect(Client, makeClient).pipe(
  Layer.provide(
    RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide(Socket.layerWebSocket(rpcUrl())),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerJson),
    ),
  ),
);

const runtime = ManagedRuntime.make(layer);

/** Runs one RPC and returns a promise; failures reject with the typed error. */
export const rpc = <A, E>(f: (client: ApolloClient) => Effect.Effect<A, E>): Promise<A> =>
  runtime.runPromise(Effect.flatMap(Client, f));

/**
 * Follows a streaming RPC, restarting it whenever it fails (for example after
 * the server restarts). `open` is re-invoked on each restart so it can resume
 * from the latest known position. Returns an unsubscribe function.
 */
export const follow = <A, E>(
  open: (client: ApolloClient) => Stream.Stream<A, E>,
  onItem: (item: A) => void,
  onError?: () => void,
): (() => void) => {
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
  return () => {
    runtime.runFork(Fiber.interrupt(fiber));
  };
};

/** Human-readable message from an RPC failure. */
export const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
};
