import * as Schema from "effect/Schema";

/** Reaching Apollo from other devices (phones) over the user's Tailscale network. */
export const RemoteAccess = Schema.Struct({
  /**
   * Apollo's own Tailscale node (it runs inside Apollo; the Tailscale app is not needed):
   * `missing` when this build has no Tailscale support, `stopped` while publishing is off,
   * `needs-login` until the user signs it in at `loginUrl`, then `starting` and `running`.
   */
  tailscale: Schema.Literals(["missing", "stopped", "needs-login", "starting", "running"]),
  /** Apollo's machine name on the tailnet, e.g. `apollo-laptop.tail1234.ts.net`. */
  dnsName: Schema.NullOr(Schema.String),
  /** Apollo is published to the tailnet (HTTPS, tailnet only) at `url`. */
  enabled: Schema.Boolean,
  url: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  /** This computer's tailnet identity, pinned by the phone at pairing. */
  nodeId: Schema.NullOr(Schema.String),
  userId: Schema.NullOr(Schema.String),
  /** Where to sign Apollo's node in to the tailnet, while it waits for that. */
  loginUrl: Schema.NullOr(Schema.String),
  /** The Tailscale account Apollo's node is signed in as. */
  loginName: Schema.NullOr(Schema.String),
});
export type RemoteAccess = typeof RemoteAccess.Type;

/**
 * What the phone app's QR code holds:
 * `apollo://pair?server=<url>&token=<token>&node=<StableID>&user=<user ID>`.
 * `node` and `user` pin this computer's tailnet identity; the phone's own tailnet node
 * refuses to connect to anything else.
 */
export const pairingQrPayload = (serverUrl: string, token: string, pin?: { nodeId: string; userId: string }) =>
  `apollo://pair?server=${encodeURIComponent(serverUrl)}&token=${encodeURIComponent(token)}` +
  (pin ? `&node=${encodeURIComponent(pin.nodeId)}&user=${encodeURIComponent(pin.userId)}` : "");
