/**
 * A device on the user's tailnet, as Tailscale identifies it. Only Apollo's tailnet
 * listener (the Go addon in apps/server/native/tailnet) produces these, after checking the
 * device is one of the owner's own: untagged, not shared in, and signed in as the same
 * Tailscale user as Apollo's node.
 */
export interface TailnetPeer {
  /** Tailscale's StableID for the node, e.g. `nAbC123CNTRL`. */
  readonly nodeId: string;
  /** Tailscale user ID, as a decimal string (it does not fit in a JS number safely). */
  readonly userId: string;
  readonly loginName: string;
  /** MagicDNS name without the trailing dot, e.g. `iphone.tail1234.ts.net`. */
  readonly nodeName: string;
  readonly os: string;
}
