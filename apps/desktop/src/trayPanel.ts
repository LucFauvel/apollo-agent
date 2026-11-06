import { BrowserWindow, screen, type Tray } from "electron";

/** One row of the panel. */
export type PanelRow =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "item"; readonly text: string; readonly detail?: string; readonly dot?: "working" | "needs" | "idle" | "paused" | "ok" | "warn" | "off"; readonly progress?: number; readonly action?: string }
  | { readonly kind: "separator" };

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const WIDTH = 300;

const STYLE = `
:root { color-scheme: light dark; --fg: #18181b; --muted: #71717a; --hover: rgba(0,0,0,.07); --line: rgba(0,0,0,.08); --track: rgba(0,0,0,.1); }
@media (prefers-color-scheme: dark) { :root { --fg: #f4f4f5; --muted: #a1a1aa; --hover: rgba(255,255,255,.1); --line: rgba(255,255,255,.1); --track: rgba(255,255,255,.14); } }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--fg); user-select: none; -webkit-user-select: none; cursor: default; overflow: hidden; }
#root { padding: 5px; }
.h { padding: 7px 9px 3px; font-size: 11px; font-weight: 600; color: var(--muted); }
.i { display: flex; align-items: center; gap: 8px; padding: 5px 9px; border-radius: 6px; }
a.i { color: inherit; text-decoration: none; }
a.i:hover { background: var(--hover); }
.t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.d { color: var(--muted); font-size: 12px; white-space: nowrap; }
.s { height: 1px; margin: 5px 9px; background: var(--line); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.working { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.18); }
.needs { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.2); }
.idle { background: transparent; border: 1.5px solid var(--muted); }
.paused { background: var(--muted); }
.ok { background: #22c55e; } .warn { background: #f59e0b; } .off { background: var(--muted); }
.bar { height: 3px; border-radius: 2px; background: var(--track); margin: 0 9px 5px 24px; overflow: hidden; }
.bar > div { height: 100%; background: linear-gradient(90deg, #38bdf8, #6366f1); }
`;

const rowHtml = (row: PanelRow) => {
  if (row.kind === "separator") return `<div class="s"></div>`;
  if (row.kind === "heading") return `<div class="h">${escapeHtml(row.text)}</div>`;
  const inner = `${row.dot ? `<span class="dot ${row.dot}"></span>` : ""}<span class="t">${escapeHtml(row.text)}</span>${
    row.detail ? `<span class="d">${escapeHtml(row.detail)}</span>` : ""
  }`;
  const item = row.action
    ? `<a class="i" href="apollo-tray://${encodeURIComponent(row.action)}">${inner}</a>`
    : `<div class="i">${inner}</div>`;
  const bar =
    row.progress !== undefined
      ? `<div class="bar"><div style="width:${Math.max(0, Math.min(100, row.progress))}%"></div></div>`
      : "";
  return item + bar;
};

/**
 * The macOS menu bar panel. A native menu cannot open on a Space where none of
 * the app's windows are (another desktop, a full-screen app) while the app has a
 * Dock icon; a non-activating panel shown on every Space can.
 */
export class TrayPanel {
  readonly #tray: Tray;
  readonly #onAction: (action: string) => void;
  #window: BrowserWindow | null = null;
  #rows: ReadonlyArray<PanelRow> = [];
  #hiddenAt = 0;

  constructor(tray: Tray, onAction: (action: string) => void) {
    this.#tray = tray;
    this.#onAction = onAction;
  }

  get visible() {
    return this.#window?.isVisible() ?? false;
  }

  toggle() {
    // A click on the icon first blurs (and hides) the panel; do not reopen it at once.
    if (this.visible || Date.now() - this.#hiddenAt < 250) return this.hide();
    void this.#show();
  }

  hide() {
    if (this.#window?.isVisible()) {
      this.#window.hide();
      this.#hiddenAt = Date.now();
    }
  }

  /** Updates the rows; an open panel redraws in place. */
  setRows(rows: ReadonlyArray<PanelRow>) {
    this.#rows = rows;
    if (this.visible) void this.#render();
  }

  #create() {
    const window = new BrowserWindow({
      width: WIDTH,
      height: 120,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      transparent: true,
      // A non-activating panel: shows on the current Space without switching to Apollo's.
      type: "panel",
      vibrancy: "menu",
      visualEffectState: "active",
      roundedCorners: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
    });
    // skipTransformProcessType: otherwise Electron briefly turns Apollo into a menu bar only
    // app to do this, which hides its Dock icon. A panel window joins full-screen Spaces anyway.
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    window.setAlwaysOnTop(true, "pop-up-menu");
    window.on("blur", () => this.hide());
    // Rows are links to apollo-tray://<action>; act on them instead of navigating.
    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("apollo-tray://")) return;
      event.preventDefault();
      this.hide();
      this.#onAction(decodeURIComponent(url.slice("apollo-tray://".length).replace(/\/$/, "")));
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>${STYLE}</style><div id="root"></div>`)}`,
    );
    this.#window = window;
    return window;
  }

  async #render() {
    const window = this.#window;
    if (!window) return;
    const html = this.#rows.map(rowHtml).join("");
    const height = (await window.webContents.executeJavaScript(
      `document.getElementById("root").innerHTML = ${JSON.stringify(html)}; document.getElementById("root").offsetHeight`,
    )) as number;
    const [, current] = window.getContentSize();
    if (current !== Math.ceil(height)) window.setContentSize(WIDTH, Math.ceil(height));
    this.#place();
  }

  /** Under the menu bar icon, kept on screen. */
  #place() {
    const window = this.#window;
    if (!window) return;
    const icon = this.#tray.getBounds();
    const display = screen.getDisplayNearestPoint({ x: icon.x + icon.width / 2, y: Math.max(icon.y, 0) });
    const area = display.workArea;
    const [width] = window.getSize();
    const x = Math.round(Math.min(Math.max(icon.x + icon.width / 2 - width! / 2, area.x + 6), area.x + area.width - width! - 6));
    // Just under the menu bar. The icon's reported y shifts with menu bar auto-hiding and
    // full-screen Spaces, but its height is the menu bar's.
    const y = Math.round(display.bounds.y + icon.height + 4);
    window.setBounds({ x, y, width: width!, height: window.getSize()[1]! }, false);
  }

  async #show() {
    const window = this.#window ?? this.#create();
    if (window.webContents.isLoading()) await new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
    await this.#render();
    window.show();
    // macOS may move a window as it is shown; place it again once visible.
    this.#place();
    window.focus();
  }
}
