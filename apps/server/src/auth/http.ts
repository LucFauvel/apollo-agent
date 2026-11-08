import { type AuthStatus, PairingDecision, PairRequest, type PairResponse } from "@apollo/contracts";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ServerConfig } from "../Config.ts";
import { Tailscale } from "../remote/Tailscale.ts";
import type { TailnetPeer } from "../remote/TailnetPeer.ts";
import { Auth, CLIENT_SESSION_TTL_MS, pairingUrl, type RequestContext, SESSION_COOKIE } from "./Auth.ts";
import { PROOF_HEADER } from "./DeviceProof.ts";

/** The session token a request presents: `Authorization: Bearer` or the session cookie. */
export const presentedToken = (request: HttpServerRequest.HttpServerRequest) => {
  const header = request.headers.authorization ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return request.cookies[SESSION_COOKIE] ?? "";
};

const pathOf = (url: string) => new URL(url, "http://apollo.invalid").pathname;

/** The verified tailnet device behind a request, or null when it was made on this computer. */
const peerOf = (tailscale: Tailscale["Service"], request: HttpServerRequest.HttpServerRequest): TailnetPeer | null => {
  try {
    return tailscale.peerFor(NodeHttpServerRequest.toIncomingMessage(request).socket);
  } catch {
    return null;
  }
};

const isLoopback = (address: string | undefined) =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

/**
 * Whether a request was made on this computer: over loopback, and not relayed from the
 * tailnet (relayed connections arrive over loopback too, but carry a peer). Clients on
 * other machines reaching a non-loopback `APOLLO_HOST` are not local.
 */
export const isLocal = (tailscale: Tailscale["Service"], request: HttpServerRequest.HttpServerRequest) => {
  if (peerOf(tailscale, request) !== null) return false;
  try {
    return isLoopback(NodeHttpServerRequest.toIncomingMessage(request).socket.remoteAddress);
  } catch {
    return false;
  }
};

/**
 * The client the guard authorized for a request, by its Node request. Handlers read it
 * here instead of authorizing again: a device proof works once, so a second check fails.
 */
const authorizedClients = new WeakMap<object, AuthorizedClient>();
type AuthorizedClient = Extract<ReturnType<Auth["Service"]["authorize"]>, { ok: true }>["client"];
const nodeRequest = (request: HttpServerRequest.HttpServerRequest): object | null => {
  try {
    return NodeHttpServerRequest.toIncomingMessage(request);
  } catch {
    return null;
  }
};

const requestContext = (request: HttpServerRequest.HttpServerRequest, peer: TailnetPeer | null): RequestContext => {
  const proof = request.headers[PROOF_HEADER];
  return { peer, method: request.method, path: pathOf(request.url), proof: typeof proof === "string" ? proof : undefined };
};

/** The phone app talks to a relay on the phone's own loopback, which carries it over its tailnet node. */
const isPhoneRelayOrigin = (origin: string) => /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);

/**
 * Paths reachable without a paired session. The UI's static files carry no
 * data and must load so an unpaired browser can show the pairing screen.
 * `/mcp` authenticates agents with its own per-session bearer tokens.
 */
const isPublic = (path: string) =>
  path === "/health" ||
  path === "/api/auth/session" ||
  path === "/api/auth/pair" ||
  path === "/mcp" ||
  // Authenticated by its handler with the desktop bootstrap token.
  path === "/api/desktop/status" ||
  !(path === "/rpc" || path.startsWith("/api/"));

const cookieOptions = (request: HttpServerRequest.HttpServerRequest, peer: TailnetPeer | null) => ({
  httpOnly: true,
  sameSite: "strict" as const,
  path: "/",
  secure: peer !== null || request.headers["x-forwarded-proto"] === "https",
});

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

/**
 * Global guard for every request:
 * 1. Browser requests from a foreign `Origin` are refused. Browsers do not apply
 *    CORS to WebSockets, so this stops arbitrary web pages from reaching /rpc.
 * 2. Everything not public requires a paired client session, presented from the
 *    tailnet device it is bound to and signed by its device key when it has one.
 */
export const layerGuard = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const auth = yield* Auth;
    const tailscale = yield* Tailscale;
    const allowedOrigins = new Set(config.allowedOrigins);
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const peer = peerOf(tailscale, request);
        const origin = request.headers.origin;
        if (
          origin !== undefined &&
          !allowedOrigins.has(origin) &&
          !tailscale.isTailnetOrigin(origin) &&
          !(peer !== null && isPhoneRelayOrigin(origin))
        ) {
          yield* Effect.logWarning("rejected request from a foreign origin", { origin, url: request.url });
          return HttpServerResponse.text("Forbidden origin", { status: 403 });
        }
        if (isPublic(pathOf(request.url))) return yield* httpEffect;
        const authorization = auth.authorize(presentedToken(request), requestContext(request, peer));
        if (!authorization.ok) return json({ error: authorization.error }, 401);
        const { client } = authorization;
        const node = nodeRequest(request);
        if (node) authorizedClients.set(node, client);
        // A WebSocket lives inside this effect for the whole connection: interrupt it
        // the moment its client is revoked, so revocation also cuts open connections.
        const revoked = Effect.callback<void>((resume) => {
          const unsubscribe = auth.onRevoked(client.id, () => resume(Effect.void));
          return Effect.sync(unsubscribe);
        });
        return yield* Effect.raceFirst(
          httpEffect,
          revoked.pipe(Effect.as(json({ error: "This device was revoked." }, 401))),
        );
      });
  }),
  { global: true },
);

const layerSession = HttpRouter.add(
  "GET",
  "/api/auth/session",
  Effect.gen(function* () {
    const auth = yield* Auth;
    const tailscale = yield* Tailscale;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = auth.authorize(presentedToken(request), requestContext(request, peerOf(tailscale, request)));
    const client = authorization.ok ? authorization.client : null;
    const status: AuthStatus = {
      authenticated: client !== null,
      clientId: client?.id ?? null,
      label: client?.label ?? null,
    };
    return json(status);
  }),
);

const layerPair = HttpRouter.add(
  "POST",
  "/api/auth/pair",
  Effect.gen(function* () {
    const auth = yield* Auth;
    const tailscale = yield* Tailscale;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const peer = peerOf(tailscale, request);
    const body = yield* HttpServerRequest.schemaBodyJson(PairRequest);
    const deviceKey = body.deviceKey ?? null;
    if (deviceKey !== null && !auth.verifyNewDeviceKey(deviceKey, requestContext(request, peer))) {
      return json({ error: "The device key is invalid or the request is not signed with it." }, 400);
    }
    // On this computer, a valid token is enough. A tailnet device also needs someone at the
    // computer to allow it, and its session only works from that device. Anything else (a
    // client on another machine, when Apollo listens beyond loopback) cannot pair.
    if (peer === null && !isLocal(tailscale, request)) {
      return json({ error: "Pair from this computer, or over Tailscale." }, 403);
    }
    const waiting = peer === null ? auth.redeem(body.token, body.label, Date.now(), deviceKey) : auth.requestPairing(body.token, body.label, peer, deviceKey);
    if (waiting === null) {
      return json({ error: "This pairing link is invalid, expired or already used." }, 400);
    }
    const session = waiting instanceof Promise ? yield* Effect.promise(() => waiting) : waiting;
    if (session === null) {
      return json({ error: "Pairing was not allowed on the computer." }, 403);
    }
    const result: PairResponse = {
      clientId: session.clientId,
      sessionToken: body.bearer ? session.sessionToken : null,
    };
    return json(result).pipe(
      HttpServerResponse.setCookieUnsafe(SESSION_COOKIE, session.sessionToken, {
        ...cookieOptions(request, peer),
        maxAge: Duration.millis(CLIENT_SESSION_TTL_MS),
      }),
    );
  }).pipe(Effect.catch(() => Effect.succeed(json({ error: "Malformed pairing request." }, 400)))),
);

const layerLogout = HttpRouter.add(
  "POST",
  "/api/auth/logout",
  Effect.gen(function* () {
    const auth = yield* Auth;
    const tailscale = yield* Tailscale;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const peer = peerOf(tailscale, request);
    // The guard already authorized this request (and used up its device proof).
    const node = nodeRequest(request);
    const client = node ? authorizedClients.get(node) : undefined;
    if (!client) return json({ error: "Not signed in." }, 401);
    auth.revokeClient(client.id);
    return json({ ok: true }).pipe(HttpServerResponse.expireCookieUnsafe(SESSION_COOKIE, cookieOptions(request, peer)));
  }),
);

/**
 * Pairing requests from tailnet devices, answered only on this computer (like a local
 * y/N): a paired phone, or a client on another machine, cannot let another device in.
 */
const localOnly = <A, E, R>(handler: Effect.Effect<A | HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const tailscale = yield* Tailscale;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!isLocal(tailscale, request)) return json({ error: "Answer pairing requests on the computer." }, 403);
    return yield* handler;
  });

const layerPendingPairings = HttpRouter.add(
  "GET",
  "/api/auth/pairing/pending",
  localOnly(
    Effect.gen(function* () {
      const auth = yield* Auth;
      return json(auth.listPending());
    }),
  ),
);

const layerDecidePairing = HttpRouter.add(
  "POST",
  "/api/auth/pairing/decide",
  localOnly(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const body = yield* HttpServerRequest.schemaBodyJson(PairingDecision);
      return auth.decidePairing(body.id, body.approve)
        ? json({ ok: true })
        : json({ error: "That pairing request has expired." }, 404);
    }),
  ).pipe(Effect.catch(() => Effect.succeed(json({ error: "Malformed decision." }, 400)))),
);

/** On a fresh install, print a pairing link so the first device can get in. */
const layerFirstRunLink = Layer.effectDiscard(
  Effect.gen(function* () {
    const auth = yield* Auth;
    const config = yield* ServerConfig;
    if (auth.hasClients() || config.desktopBootstrapToken) return;
    const { token } = auth.createPairingToken("");
    yield* Effect.logInfo(
      `No paired devices yet. Open this link within 10 minutes to pair: ${pairingUrl(config.publicUrl, token)}`,
    );
  }),
);

export const layer = Layer.mergeAll(
  layerGuard,
  layerSession,
  layerPair,
  layerLogout,
  layerPendingPairings,
  layerDecidePairing,
  layerFirstRunLink,
);
