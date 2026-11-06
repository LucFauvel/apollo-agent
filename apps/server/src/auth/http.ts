import { type AuthStatus, PairRequest, type PairResponse } from "@apollo/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ServerConfig } from "../Config.ts";
import { Tailscale } from "../remote/Tailscale.ts";
import { Auth, CLIENT_SESSION_TTL_MS, pairingUrl, SESSION_COOKIE } from "./Auth.ts";

/** The session token a request presents: `Authorization: Bearer` or the session cookie. */
export const presentedToken = (request: HttpServerRequest.HttpServerRequest) => {
  const header = request.headers.authorization ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return request.cookies[SESSION_COOKIE] ?? "";
};

const pathOf = (url: string) => new URL(url, "http://apollo.invalid").pathname;

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

const cookieOptions = (request: HttpServerRequest.HttpServerRequest) => ({
  httpOnly: true,
  sameSite: "strict" as const,
  path: "/",
  secure: request.headers["x-forwarded-proto"] === "https",
});

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

/**
 * Global guard for every request:
 * 1. Browser requests from a foreign `Origin` are refused. Browsers do not apply
 *    CORS to WebSockets, so this stops arbitrary web pages from reaching /rpc.
 * 2. Everything not public requires a paired client session.
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
        const origin = request.headers.origin;
        if (origin !== undefined && !allowedOrigins.has(origin) && !tailscale.isTailnetOrigin(origin)) {
          yield* Effect.logWarning("rejected request from a foreign origin", { origin, url: request.url });
          return HttpServerResponse.text("Forbidden origin", { status: 403 });
        }
        if (isPublic(pathOf(request.url))) return yield* httpEffect;
        const client = auth.authenticate(presentedToken(request));
        if (client === null) return json({ error: "This device is not paired with Apollo." }, 401);
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
    const request = yield* HttpServerRequest.HttpServerRequest;
    const client = auth.authenticate(presentedToken(request));
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
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* HttpServerRequest.schemaBodyJson(PairRequest);
    const session = auth.redeem(body.token, body.label);
    if (session === null) {
      return json({ error: "This pairing link is invalid, expired or already used." }, 400);
    }
    const result: PairResponse = {
      clientId: session.clientId,
      sessionToken: body.bearer ? session.sessionToken : null,
    };
    return json(result).pipe(
      HttpServerResponse.setCookieUnsafe(SESSION_COOKIE, session.sessionToken, {
        ...cookieOptions(request),
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
    const request = yield* HttpServerRequest.HttpServerRequest;
    const client = auth.authenticate(presentedToken(request));
    if (client) auth.revokeClient(client.id);
    return json({ ok: true }).pipe(HttpServerResponse.expireCookieUnsafe(SESSION_COOKIE, cookieOptions(request)));
  }),
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

export const layer = Layer.mergeAll(layerGuard, layerSession, layerPair, layerLogout, layerFirstRunLink);
