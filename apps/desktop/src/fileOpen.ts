import { extname } from "node:path";

/**
 * Files that run something when opened (apps, scripts, installers, shortcuts): a link to one
 * shows it in Finder or Explorer instead, so a click on an agent's link never runs code.
 */
const RUNS: Record<"darwin" | "win32" | "linux", ReadonlySet<string>> = {
  darwin: new Set([
    ".app", ".command", ".tool", ".terminal", ".sh", ".bash", ".zsh", ".csh", ".ksh", ".fish", ".pkg", ".mpkg", ".workflow",
    ".action", ".prefpane", ".kext", ".osax", ".webloc", ".inetloc", ".fileloc", ".jar", ".scptd", ".applescript", ".scpt",
  ]),
  win32: new Set([
    ".exe", ".com", ".bat", ".cmd", ".msi", ".msix", ".msp", ".scr", ".pif", ".cpl", ".ps1", ".psm1", ".vbs", ".vbe", ".js",
    ".jse", ".wsf", ".wsh", ".hta", ".lnk", ".url", ".reg", ".appref-ms", ".application", ".jar", ".py", ".pyw", ".pl", ".rb",
    ".sh", ".appx", ".appxbundle", ".msixbundle", ".gadget", ".inf", ".scf", ".settingcontent-ms",
  ]),
  linux: new Set([".desktop", ".appimage", ".run", ".bin", ".sh", ".bash", ".deb", ".rpm", ".jar", ".flatpakref", ".snap"]),
};

export interface OpenTarget {
  readonly path: string;
  readonly directory: boolean;
  /** Has an executable bit (macOS and Linux may run those in a terminal). */
  readonly executable: boolean;
}

/** Whether a file link opens the file in its default app or shows it in Finder or Explorer. */
export const fileOpenAction = (target: OpenTarget, reveal: boolean, platform: NodeJS.Platform): "open" | "reveal" => {
  if (reveal) return "reveal";
  const runs = platform === "darwin" || platform === "win32" ? RUNS[platform] : RUNS.linux;
  if (runs.has(extname(target.path).toLowerCase())) return "reveal";
  if (platform !== "win32" && !target.directory && target.executable) return "reveal";
  return "open";
};
