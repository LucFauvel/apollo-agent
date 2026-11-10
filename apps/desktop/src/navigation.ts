/**
 * What the main window does when its page tries to navigate (a clicked link, a script):
 * the app's own pages load in place; web and mail links go to the user's browser or mail
 * app; anything else (file:, data:, custom schemes, unparsable URLs) is dropped.
 */
export type NavigationDecision = "allow" | "external" | "block";

export const navigationDecision = (target: string, appOrigins: ReadonlyArray<string>): NavigationDecision => {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "block";
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && appOrigins.includes(url.origin)) return "allow";
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return "external";
  return "block";
};

/**
 * What a request to open a new window (a `target=_blank` link, `window.open`) does: the
 * app's own pages (and blobs it made) open in an app window, never the system browser, so
 * no app URL, nor what its path, query or fragment carries, leaves the app; web and mail
 * links go to the user's browser or mail app; anything else is dropped.
 */
export type WindowOpenDecision = "show" | "in-app" | "external" | "block";

export const windowOpenDecision = (target: string, appOrigins: ReadonlyArray<string>): WindowOpenDecision => {
  // The page asks to be shown (e.g. a notification was clicked while the window was hidden).
  if (target === "apollo-desktop://show") return "show";
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "block";
  }
  if ((url.protocol === "http:" || url.protocol === "https:" || url.protocol === "blob:") && appOrigins.includes(url.origin)) return "in-app";
  return navigationDecision(target, appOrigins) === "external" ? "external" : "block";
};
