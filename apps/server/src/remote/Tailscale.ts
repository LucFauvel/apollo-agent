import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ApolloError, type RemoteAccess } from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../Config.ts";
import { Store } from "../Store.ts";
import type { TailnetPeer } from "./TailnetPeer.ts";

/** HTTPS port on the tailnet; not 443, so it never clashes with anything else on the node. */
export const TAILNET_PORT = Number(process.env.APOLLO_TAILNET_PORT) || 8443;
const SETTING = "remote.tailscale";
/** The node's machine name on the tailnet, chosen once and then kept (see `machineName`). */
const HOSTNAME_SETTING = "remote.tailscale.hostname";
/** How often the node's state is re-read while it runs (login finished, reconnects). */
const REFRESH_INTERVAL = "5 seconds";

/** The Node-API addon (apps/server/native/tailnet): a Tailscale node inside this process. */
interface Addon {
  readonly call: (method: string, args: string) => Promise<string>;
  readonly callSync: (method: string, args: string) => string;
}

/** What the addon reports about its node. */
interface NodeStatus {
  readonly state: string;
  readonly authUrl: string | null;
  readonly nodeId: string | null;
  readonly userId: string | null;
  readonly loginName: string | null;
  readonly dnsName: string | null;
  readonly listening: boolean;
  readonly error: string | null;
}

const STOPPED: NodeStatus = {
  state: "NoState",
  authUrl: null,
  nodeId: null,
  userId: null,
  loginName: null,
  dnsName: null,
  listening: false,
  error: null,
};

const loadAddon = (path: string | undefined): { addon: Addon | null; problem: string | null } => {
  if (!path) return { addon: null, problem: "This build of Apollo has no Tailscale support (APOLLO_TAILNET_ADDON is not set)." };
  if (!existsSync(path)) return { addon: null, problem: `Tailscale support is not built: run apps/server/native/tailnet/build.sh (${path}).` };
  try {
    const module = { exports: {} as Addon };
    process.dlopen(module, path);
    return { addon: module.exports, problem: null };
  } catch (error) {
    return { addon: null, problem: `Could not load Tailscale support: ${(error as Error).message}` };
  }
};

const loopback = (address: string | undefined) =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

/**
 * This computer's name as its user set it. On macOS, `os.hostname()` follows the network
 * (a DHCP or reverse-DNS name such as `mac-lan` on one network, the Sharing name on
 * another), so the Sharing "Local hostname" is read instead.
 */
const computerName = () => {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 2000 }).trim();
      if (name) return name;
    } catch {
      // No LocalHostName set: fall back to the host name.
    }
  }
  return hostname();
};

/** A tailnet machine name from a computer name: `Luc's MacBook.local` → `apollo-lucs-macbook`. */
export const nodeHostname = (name: string) =>
  `apollo-${name
    .replace(/\.local$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "") || "desktop"}`;

/**
 * Whether Apollo announces `name` as its machine name: one lowercase DNS label, which
 * every `nodeHostname` result is. Names read back (the saved setting, the node's own
 * state) must pass it too, so a malformed one is never kept.
 */
export const isMachineName = (name: string) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name);

/**
 * Publishes Apollo to the user's tailnet through a Tailscale node that runs inside this
 * process (the `apollo_tailnet` Node-API addon, built from Go's tsnet). It uses
 * userspace networking: the system Tailscale app does not need to be running, and no
 * VPN interface is created, so another VPN can stay on.
 *
 * The node signs in to the user's tailnet once (a login link shown in the app) and shows
 * up there as its own machine. Its listener admits only the owner's own devices, checked
 * before the TLS handshake, and relays them to Apollo's localhost port; `peerFor` maps a
 * relayed request back to the device it came from.
 */
const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const store = yield* Store;
  const { addon, problem } = loadAddon(config.tailnetAddon);
  const stateDir = join(config.dataDir, "tailnet-node");
  let node: NodeStatus = STOPPED;
  let lastError: string | null = null;
  /** The tailnet origin while published, kept for the request guard. */
  let tailnetOrigin: string | null = null;

  const invoke = async <A>(method: string, args: object = {}): Promise<A> => {
    if (!addon) throw new Error(problem ?? "Tailscale support is not available");
    const parsed = JSON.parse(await addon.call(method, JSON.stringify(args))) as A & { error?: string };
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") throw new Error(parsed.error);
    return parsed;
  };

  const urlFor = (dnsName: string) => `https://${dnsName}:${TAILNET_PORT}`;

  /**
   * The node's machine name, chosen the first time and then kept. Tailscale renames the
   * machine (and its DNS name) to whatever name the node announces at start, and paired
   * phones reach Apollo at the DNS name from their QR code: a name that followed the
   * network would strand them after the next restart (an update, a reboot).
   *
   * The first choice keeps the name an existing node already announces (phones may be
   * paired at it); only a node that never signed in gets one from the computer's name.
   * A saved or announced name that is not a valid machine name is never kept: it is
   * replaced as if absent, so a bad value saved once does not stick.
   * If the existing name cannot be read, this start announces what Apollo used to
   * (`os.hostname()`), and nothing is saved, so the next start tries again.
   */
  const machineName = Effect.gen(function* () {
    const saved = yield* store.getSetting(HOSTNAME_SETTING);
    if (saved && isMachineName(saved)) return saved;
    const existing = yield* Effect.promise(() =>
      invoke<{ readonly hostname?: string | null }>("savedHostname", { dir: stateDir }).then(
        (result) => ({ ok: true as const, hostname: typeof result?.hostname === "string" ? result.hostname : null }),
        () => ({ ok: false as const, hostname: null }),
      ),
    );
    if (!existing.ok) return nodeHostname(hostname());
    const chosen = existing.hostname !== null && isMachineName(existing.hostname) ? existing.hostname : nodeHostname(computerName());
    yield* store.setSetting(HOSTNAME_SETTING, chosen);
    return chosen;
  });

  const startNode = (name: string) =>
    invoke<NodeStatus>("start", { dir: stateDir, hostname: name, port: TAILNET_PORT, upstreamPort: config.port });

  /** Re-reads the node's state; `null` when the node is not running. */
  const refresh = async () => {
    if (!addon) return;
    try {
      node = await invoke<NodeStatus>("status");
      lastError = node.error;
    } catch (error) {
      lastError = (error as Error).message;
    }
  };

  const enabledSetting = store.getSetting(SETTING).pipe(Effect.map((value) => value === "on"));

  const read: Effect.Effect<RemoteAccess> = Effect.gen(function* () {
    const enabled = yield* enabledSetting;
    if (enabled) yield* Effect.promise(refresh);
    const published = enabled && node.listening && node.dnsName !== null;
    tailnetOrigin = published ? urlFor(node.dnsName!) : null;
    return {
      tailscale: !addon
        ? "missing"
        : !enabled || node.state === "NoState" || node.state === "Stopped"
          ? "stopped"
          : node.state === "NeedsLogin" || node.state === "NeedsMachineAuth"
            ? "needs-login"
            : node.state === "Running"
              ? "running"
              : "starting",
      dnsName: node.dnsName,
      enabled,
      url: tailnetOrigin,
      error: !addon ? problem : lastError,
      nodeId: node.nodeId,
      userId: node.userId,
      loginUrl: enabled && node.state === "NeedsLogin" ? node.authUrl : null,
      loginName: node.loginName,
    };
  });

  const fail = (message: string) => new ApolloError({ code: "internal", message });

  const setEnabled = (enabled: boolean) =>
    Effect.gen(function* () {
      lastError = null;
      if (enabled) {
        if (!addon) return yield* new ApolloError({ code: "invalid", message: problem ?? "Tailscale support is not available" });
        // Saved first: a node waiting for its first login keeps going, and is started again after a restart.
        yield* store.setSetting(SETTING, "on");
        const name = yield* machineName;
        node = yield* Effect.tryPromise({ try: () => startNode(name), catch: (e) => fail(`Could not start Tailscale: ${(e as Error).message}`) });
      } else {
        yield* store.setSetting(SETTING, null);
        if (addon) yield* Effect.promise(() => invoke("stop").catch(() => undefined));
        node = STOPPED;
      }
      return yield* read;
    });

  /** Signs Apollo's node out of the tailnet and forgets it; turning it on again asks for a new login. */
  const signOut = Effect.gen(function* () {
    yield* store.setSetting(SETTING, null);
    if (addon) yield* Effect.tryPromise({ try: () => invoke("logout"), catch: (e) => fail(`Could not sign out: ${(e as Error).message}`) });
    node = STOPPED;
    lastError = null;
    return yield* read;
  });

  yield* Effect.addFinalizer(() => (addon ? Effect.promise(() => invoke("stop").catch(() => undefined)) : Effect.void));

  // Start the node again at startup, then follow it (login finished, reconnects, sleep).
  yield* Effect.gen(function* () {
    if (addon && (yield* enabledSetting)) {
      if (node.state === "NoState") {
        const name = yield* machineName;
        node = yield* Effect.promise(() => startNode(name).catch((error: Error) => ({ ...STOPPED, error: error.message })));
        lastError = node.error;
      } else {
        yield* Effect.promise(refresh);
      }
      tailnetOrigin = node.listening && node.dnsName ? urlFor(node.dnsName) : null;
    }
    yield* Effect.sleep(REFRESH_INTERVAL);
  }).pipe(Effect.forever, Effect.forkScoped);

  return {
    read,
    setEnabled,
    signOut,
    /** Requests through the tailnet address carry it as their Origin (browsers on other devices). */
    isTailnetOrigin: (origin: string) => tailnetOrigin !== null && origin === tailnetOrigin,
    /**
     * The tailnet device behind a request's socket, when it came through the tailnet
     * listener's relay; null for requests made on this computer.
     */
    peerFor: (socket: { readonly remoteAddress?: string | undefined; readonly remotePort?: number | undefined }): TailnetPeer | null => {
      if (!addon || !loopback(socket.remoteAddress) || socket.remotePort === undefined) return null;
      try {
        return JSON.parse(addon.callSync("peer", JSON.stringify({ port: socket.remotePort }))) as TailnetPeer | null;
      } catch {
        return null;
      }
    },
  };
});

export class Tailscale extends Context.Service<Tailscale, Effect.Success<typeof make>>()("apollo/Tailscale") {}

export const layer = Layer.effect(Tailscale, make);
