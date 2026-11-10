/** Schemes an agent's page may hand to the phone: web pages and mail drafts, never app launchers. */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** How long after the user touched a page a navigation still counts as theirs. */
export const TAP_WINDOW_MS = 1500;

export interface PageNavigation {
  readonly url: string;
  readonly isTopFrame: boolean;
  /** `click` on iOS when a link was activated; always `other` on Android. */
  readonly navigationType: string;
}

/**
 * What an agent-written page may do with a navigation: load it inside the page (its own
 * document, anchors, frames), open it outside (a link the user just tapped, to an allowed
 * scheme), or nothing. Script redirects and app-launching schemes never leave the page.
 */
export const pageNavigation = (
  request: PageNavigation,
  lastTouchAt: number | null,
  now: number,
  platform: "ios" | "android" | string,
): "load" | "external" | "block" => {
  if (/^(about|data|blob):/i.test(request.url)) return "load";
  if (!request.isTopFrame) return /^https?:/i.test(request.url) ? "load" : "block";
  let scheme: string;
  try {
    scheme = new URL(request.url).protocol.toLowerCase();
  } catch {
    return "block";
  }
  if (!EXTERNAL_SCHEMES.has(scheme)) return "block";
  const tapped = lastTouchAt !== null && now - lastTouchAt >= 0 && now - lastTouchAt <= TAP_WINDOW_MS;
  if (!tapped) return "block";
  if (platform === "ios" && request.navigationType !== "click") return "block";
  return "external";
};
