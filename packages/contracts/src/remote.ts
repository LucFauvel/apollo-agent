import * as Schema from "effect/Schema";

/** Reaching Apollo from other devices (phones) over the user's Tailscale network. */
export const RemoteAccess = Schema.Struct({
  /** The tailscale CLI was found and the machine is signed in to a tailnet. */
  tailscale: Schema.Literals(["missing", "stopped", "running"]),
  /** This machine's name on the tailnet, e.g. `laptop.tail1234.ts.net`. */
  dnsName: Schema.NullOr(Schema.String),
  /** Apollo is published to the tailnet (HTTPS, tailnet only) at `url`. */
  enabled: Schema.Boolean,
  url: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type RemoteAccess = typeof RemoteAccess.Type;

/** What the phone app's QR code holds: `apollo://pair?server=<url>&token=<token>`. */
export const pairingQrPayload = (serverUrl: string, token: string) =>
  `apollo://pair?server=${encodeURIComponent(serverUrl)}&token=${encodeURIComponent(token)}`;
