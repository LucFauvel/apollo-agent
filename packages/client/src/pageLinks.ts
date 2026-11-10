/** Schemes an agent's page may offer to open outside the app: web pages and mail drafts, never app launchers. */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export interface PageNavigation {
  readonly url: string;
  readonly isTopFrame: boolean;
}

/**
 * What an agent-written page may do with a navigation: load it inside the page (its own
 * document, anchors, web frames), ask the user to open it outside (a web or mail link), or
 * nothing. A page cannot leave the app on its own: neither a touch nor the navigation type
 * tells a tapped link from a script's `click()`, so only the user's answer to a native
 * prompt opens it.
 */
export const pageNavigation = (request: PageNavigation): "load" | "ask" | "block" => {
  if (/^(about|data|blob):/i.test(request.url)) return "load";
  if (!request.isTopFrame) return /^https?:/i.test(request.url) ? "load" : "block";
  return externalTarget(request.url) ? "ask" : "block";
};

/** How the prompt names a link the page wants to open: its host, or the mail address. Null when it may not open. */
export const externalTarget = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (!EXTERNAL_SCHEMES.has(scheme)) return null;
  if (scheme === "mailto:") return decodeURIComponent(parsed.pathname).split(",")[0]?.trim() || "a new email";
  return parsed.host || null;
};
