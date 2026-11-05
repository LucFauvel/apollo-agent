import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ApolloError,
  type ClientId,
  type ClientMethod,
  type PairedClient,
  type PairingToken,
} from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../Config.ts";
import { Database } from "../Database.ts";

/** Pairing links are one-time and short-lived. */
export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
/** A paired client stays signed in this long after its last use. */
export const CLIENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is refreshed at most this often per client. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export const SESSION_COOKIE = "apollo_session";

const newToken = () => randomBytes(32).toString("base64url");
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const invalidPairing = () =>
  new ApolloError({ code: "invalid", message: "This pairing link is invalid, expired or already used." });

interface ClientRow {
  readonly id: string;
  readonly label: string;
  readonly method: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly last_seen_at: number;
}

const toClient = (row: ClientRow): PairedClient => ({
  id: row.id as ClientId,
  label: row.label,
  method: row.method as ClientMethod,
  createdAt: Number(row.created_at),
  expiresAt: Number(row.expires_at),
  lastSeenAt: Number(row.last_seen_at),
});

/**
 * Synchronous pairing primitives over the Apollo database. Used by the server
 * and by the `apollo pair` CLI, which writes grants into the same database.
 */
export const makePairing = (db: DatabaseSync, options: { readonly desktopToken?: string | undefined } = {}) => {
  const lastTouch = new Map<string, number>();
  /** Callbacks for live connections, fired when their client is revoked. */
  const revocationListeners = new Map<string, Set<() => void>>();

  const createPairingToken = (label: string, now = Date.now()): PairingToken => {
    const token = newToken();
    const expiresAt = now + PAIRING_TOKEN_TTL_MS;
    db.prepare(
      "insert into pairing_grants (token_hash, label, created_at, expires_at) values (?, ?, ?, ?)",
    ).run(hashToken(token), label, now, expiresAt);
    return { token, expiresAt };
  };

  const createClientSession = (label: string, method: ClientMethod, now: number) => {
    const id = `cli_${randomBytes(10).toString("hex")}` as ClientId;
    const sessionToken = newToken();
    db.prepare(
      `insert into client_sessions (id, token_hash, label, method, created_at, expires_at, last_seen_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, hashToken(sessionToken), label, method, now, now + CLIENT_SESSION_TTL_MS, now);
    return { clientId: id, sessionToken };
  };

  /** Exchanges a pairing (or desktop bootstrap) token for a long-lived client session. */
  const redeem = (token: string, label: string, now = Date.now()) => {
    const cleanLabel = label.trim().slice(0, 80) || "Unnamed device";
    if (options.desktopToken && safeEqual(token, options.desktopToken)) {
      // Reusable for this server process: the desktop app re-pairs after a reload or wiped cookies.
      return createClientSession(cleanLabel, "desktop", now);
    }
    // Atomically claim the grant so a token can never be redeemed twice.
    const claimed = db
      .prepare(
        `update pairing_grants set used_at = ? where token_hash = ? and used_at is null and expires_at > ?
         returning label`,
      )
      .get(now, hashToken(token), now) as { label: string } | undefined;
    if (!claimed) return null;
    // A name chosen when the link was created wins over the device's own guess.
    return createClientSession(claimed.label.trim() || cleanLabel, "pairing-link", now);
  };

  /** Resolves a session token to its client, sliding the expiry on use. */
  const authenticate = (sessionToken: string, now = Date.now()): PairedClient | null => {
    if (sessionToken.length === 0) return null;
    const row = db
      .prepare(
        `select id, label, method, created_at, expires_at, last_seen_at from client_sessions
         where token_hash = ? and revoked_at is null and expires_at > ?`,
      )
      .get(hashToken(sessionToken), now) as ClientRow | undefined;
    if (!row) return null;
    if (now - (lastTouch.get(row.id) ?? 0) > TOUCH_INTERVAL_MS) {
      lastTouch.set(row.id, now);
      db.prepare("update client_sessions set last_seen_at = ?, expires_at = ? where id = ?").run(
        now,
        now + CLIENT_SESSION_TTL_MS,
        row.id,
      );
    }
    return toClient(row);
  };

  return {
    createPairingToken,
    redeem,
    authenticate,
    listClients: (now = Date.now()) =>
      (
        db
          .prepare(
            `select id, label, method, created_at, expires_at, last_seen_at from client_sessions
             where revoked_at is null and expires_at > ? order by last_seen_at desc`,
          )
          .all(now) as unknown as Array<ClientRow>
      ).map(toClient),
    revokeClient: (id: ClientId, now = Date.now()) => {
      db.prepare("update client_sessions set revoked_at = ? where id = ? and revoked_at is null").run(now, id);
      const listeners = revocationListeners.get(id);
      revocationListeners.delete(id);
      for (const listener of listeners ?? []) listener();
    },
    /** Registers `onRevoked` for a live connection; returns an unsubscribe function. */
    onRevoked: (id: ClientId, onRevoked: () => void) => {
      let listeners = revocationListeners.get(id);
      if (!listeners) {
        listeners = new Set();
        revocationListeners.set(id, listeners);
      }
      listeners.add(onRevoked);
      return () => {
        listeners.delete(onRevoked);
        if (listeners.size === 0 && revocationListeners.get(id) === listeners) revocationListeners.delete(id);
      };
    },
    hasClients: (now = Date.now()) =>
      db
        .prepare("select 1 from client_sessions where revoked_at is null and expires_at > ? limit 1")
        .get(now) !== undefined,
    /** Drops expired grants and sessions. */
    prune: (now = Date.now()) => {
      db.prepare("delete from pairing_grants where expires_at <= ? or used_at is not null").run(now);
      db.prepare("delete from client_sessions where expires_at <= ? or revoked_at is not null").run(now);
    },
  };
};

export type Pairing = ReturnType<typeof makePairing>;

export class Auth extends Context.Service<Auth, Pairing>()("apollo/Auth") {}

export const layer = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const db = yield* Database;
    const config = yield* ServerConfig;
    const pairing = makePairing(db, { desktopToken: config.desktopBootstrapToken });
    pairing.prune();
    return pairing;
  }),
);

/** The pairing URL for a token, using the URL fragment so the secret is never sent in logs. */
export const pairingUrl = (baseUrl: string, token: string) =>
  `${baseUrl.replace(/\/+$/, "")}/pair#token=${encodeURIComponent(token)}`;
