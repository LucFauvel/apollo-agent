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
