import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ApolloError,
  type ClientId,
  type ClientMethod,
  type PairedClient,
  type PairingToken,
  type PendingPairing,
} from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../Config.ts";
import { Database } from "../Database.ts";
import type { TailnetPeer } from "../remote/TailnetPeer.ts";
import { makeProofVerifier, parseDeviceKey } from "./DeviceProof.ts";

/** Pairing links are one-time and short-lived. */
export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
/** A phone QR code is shown only while someone is at the computer. */
export const PHONE_PAIRING_TTL_MS = 2 * 60 * 1000;
/** How long a tailnet device waits for someone at the computer to allow it. */
export const PAIRING_APPROVAL_TTL_MS = 60 * 1000;
/** A paired client stays signed in this long after its last use. */
export const CLIENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is refreshed at most this often per client. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export const SESSION_COOKIE = "apollo_session";

const newToken = () => randomBytes(32).toString("base64url");
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const safeEqual = (a: string, b: string) => {
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
  readonly node_id: string | null;
  readonly user_id: string | null;
  readonly node_name: string | null;
  readonly device_key: string | null;
}

const CLIENT_COLUMNS = "id, label, method, created_at, expires_at, last_seen_at, node_id, user_id, node_name, device_key";

const toClient = (row: ClientRow): PairedClient => ({
  id: row.id as ClientId,
  label: row.label,
  method: row.method as ClientMethod,
  createdAt: Number(row.created_at),
  expiresAt: Number(row.expires_at),
  lastSeenAt: Number(row.last_seen_at),
  nodeName: row.node_name,
  deviceKey: row.device_key !== null,
});

/** Where a request came from and what it presented, for `authorize`. */
export interface RequestContext {
  /** The verified tailnet device, for requests through Apollo's tailnet listener; null when local. */
  readonly peer: TailnetPeer | null;
  readonly method: string;
  readonly path: string;
  /** The `x-apollo-proof` header. */
  readonly proof: string | undefined;
}

export type Authorization =
  | { readonly ok: true; readonly client: PairedClient }
  | { readonly ok: false; readonly error: string };

interface Session {
  readonly clientId: ClientId;
  readonly sessionToken: string;
}

interface Pending {
  readonly info: PendingPairing;
  readonly peer: TailnetPeer;
  readonly deviceKey: string | null;
  readonly settle: (session: Session | null) => void;
}

/**
 * Synchronous pairing primitives over the Apollo database. Used by the server
 * and by the `apollo pair` CLI, which writes grants into the same database.
 */
export const makePairing = (db: DatabaseSync, options: { readonly desktopToken?: string | undefined } = {}) => {
  const lastTouch = new Map<string, number>();
  /** Callbacks for live connections, fired when their client is revoked. */
  const revocationListeners = new Map<string, Set<() => void>>();
  const pending = new Map<string, Pending>();
  const pendingListeners = new Set<() => void>();
  const verifyProof = makeProofVerifier();
  const keys = new Map<string, KeyObject | null>();

  const keyFor = (encoded: string) => {
    if (!keys.has(encoded)) keys.set(encoded, parseDeviceKey(encoded));
    return keys.get(encoded) ?? null;
  };

  const createPairingToken = (label: string, now = Date.now(), ttlMs = PAIRING_TOKEN_TTL_MS): PairingToken => {
    const token = newToken();
    const expiresAt = now + ttlMs;
    db.prepare(
      "insert into pairing_grants (token_hash, label, created_at, expires_at) values (?, ?, ?, ?)",
    ).run(hashToken(token), label, now, expiresAt);
    return { token, expiresAt };
  };

  const createClientSession = (
    label: string,
    method: ClientMethod,
    now: number,
    binding: { readonly peer: TailnetPeer | null; readonly deviceKey: string | null } = { peer: null, deviceKey: null },
  ): Session => {
    const id = `cli_${randomBytes(10).toString("hex")}` as ClientId;
    const sessionToken = newToken();
    db.prepare(
      `insert into client_sessions
         (id, token_hash, label, method, created_at, expires_at, last_seen_at, node_id, user_id, node_name, device_key)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      hashToken(sessionToken),
      label,
      method,
      now,
      now + CLIENT_SESSION_TTL_MS,
      now,
      binding.peer?.nodeId ?? null,
      binding.peer?.userId ?? null,
      binding.peer?.nodeName ?? null,
      binding.deviceKey,
    );
    return { clientId: id, sessionToken };
  };

  /** Atomically claims a grant so a token can never be redeemed twice. Returns its label. */
  const claim = (token: string, now: number) =>
    db
      .prepare(
        `update pairing_grants set used_at = ? where token_hash = ? and used_at is null and expires_at > ?
         returning label`,
      )
      .get(now, hashToken(token), now) as { label: string } | undefined;

  const cleanLabel = (label: string) => label.trim().slice(0, 80) || "Unnamed device";

  /**
   * Exchanges a pairing (or desktop bootstrap) token for a long-lived client session, for
   * a client on this computer. Tailnet devices go through `requestPairing` instead.
   */
  const redeem = (token: string, label: string, now = Date.now(), deviceKey: string | null = null): Session | null => {
    if (options.desktopToken && safeEqual(token, options.desktopToken)) {
      // Reusable for this server process: the desktop app re-pairs after a reload or wiped cookies.
      return createClientSession(cleanLabel(label), "desktop", now);
    }
    const claimed = claim(token, now);
    if (!claimed) return null;
    // A name chosen when the link was created wins over the device's own guess.
    return createClientSession(claimed.label.trim() || cleanLabel(label), "pairing-link", now, { peer: null, deviceKey });
  };

  const notifyPending = () => {
    for (const listener of pendingListeners) listener();
  };

  const settle = (id: string, session: Session | null) => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    entry.settle(session);
    notifyPending();
    return true;
  };

  /**
   * A tailnet device redeems a token: the token is burned now, and the device gets a
   * session bound to its tailnet identity only once someone at the computer allows it.
   * Resolves to null when denied or when nobody answers in time.
   */
  const requestPairing = (
    token: string,
    label: string,
    peer: TailnetPeer,
    deviceKey: string | null,
    now = Date.now(),
  ): Promise<Session | null> | null => {
    // The desktop bootstrap token is for the desktop app on this computer only.
    if (options.desktopToken && safeEqual(token, options.desktopToken)) return null;
    const claimed = claim(token, now);
    if (!claimed) return null;
    const id = `pp_${randomBytes(8).toString("hex")}`;
    const finalLabel = claimed.label.trim() || cleanLabel(label);
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, null), PAIRING_APPROVAL_TTL_MS);
      pending.set(id, {
        info: {
          id,
          label: finalLabel,
          nodeName: peer.nodeName,
          os: peer.os,
          loginName: peer.loginName,
          deviceKey: deviceKey !== null,
          expiresAt: now + PAIRING_APPROVAL_TTL_MS,
        },
        peer,
        deviceKey,
        settle: (session) => {
          clearTimeout(timer);
          resolve(session);
        },
      });
      notifyPending();
    });
  };

  const decidePairing = (id: string, approve: boolean, now = Date.now()) => {
    const entry = pending.get(id);
    if (!entry) return false;
    const session = approve
      ? createClientSession(entry.info.label, "pairing-link", now, { peer: entry.peer, deviceKey: entry.deviceKey })
      : null;
    return settle(id, session);
  };

  const findSession = (sessionToken: string, now: number) => {
    if (sessionToken.length === 0) return undefined;
    return db
      .prepare(
        `select ${CLIENT_COLUMNS} from client_sessions
         where token_hash = ? and revoked_at is null and expires_at > ?`,
      )
      .get(hashToken(sessionToken), now) as ClientRow | undefined;
  };

  const touch = (row: ClientRow, now: number) => {
    if (now - (lastTouch.get(row.id) ?? 0) > TOUCH_INTERVAL_MS) {
      lastTouch.set(row.id, now);
      db.prepare("update client_sessions set last_seen_at = ?, expires_at = ? where id = ?").run(
        now,
        now + CLIENT_SESSION_TTL_MS,
        row.id,
      );
    }
  };

  /**
   * Resolves a session token to its client, sliding the expiry on use. Checks only the
   * token: use `authorize` for requests, which also checks where they come from.
   */
  const authenticate = (sessionToken: string, now = Date.now()): PairedClient | null => {
    const row = findSession(sessionToken, now);
    if (!row) return null;
    touch(row, now);
    return toClient(row);
  };

  /**
   * The full check for a request: a valid session token, presented from the tailnet
   * device the session is bound to (or locally, for unbound sessions), and signed by
   * the session's device key when it has one.
   */
  const authorize = (sessionToken: string, context: RequestContext, now = Date.now()): Authorization => {
    const row = findSession(sessionToken, now);
    if (!row) return { ok: false, error: "This device is not paired with Apollo." };
    const { peer } = context;
    if (row.node_id !== null) {
      if (peer === null || peer.nodeId !== row.node_id || peer.userId !== row.user_id) {
        return { ok: false, error: "This pairing belongs to another device." };
      }
    } else if (peer !== null) {
      // Paired on this computer, or before Apollo tied devices to their tailnet identity.
      return { ok: false, error: "Pair this device with Apollo again." };
    }
    if (row.device_key !== null) {
      const key = keyFor(row.device_key);
      if (key === null || !verifyProof(context.proof, key, context, now)) {
        return { ok: false, error: "This request is not signed by the paired device." };
      }
    }
    touch(row, now);
    return { ok: true, client: toClient(row) };
  };

  return {
    createPairingToken,
    redeem,
    requestPairing,
    decidePairing,
    listPending: (): ReadonlyArray<PendingPairing> => [...pending.values()].map((entry) => entry.info),
    /** Called whenever a pairing request appears or is settled; returns an unsubscribe function. */
    onPendingChange: (listener: () => void) => {
      pendingListeners.add(listener);
      return () => void pendingListeners.delete(listener);
    },
    /** Verifies that a pairing request is signed by the key it registers. */
    verifyNewDeviceKey: (deviceKey: string, context: RequestContext, now = Date.now()) => {
      const key = parseDeviceKey(deviceKey);
      return key !== null && verifyProof(context.proof, key, context, now);
    },
    authenticate,
    authorize,
    listClients: (now = Date.now()) =>
      (
        db
          .prepare(
            `select ${CLIENT_COLUMNS} from client_sessions
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
