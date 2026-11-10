const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

/**
 * `window.apolloDesktop` in the app's page. Opening a file needs the user's click: the call
 * is refused unless the page has transient user activation, which scripts cannot fake.
 */
contextBridge.exposeInMainWorld("apolloDesktop", {
  openFile: (request: { sessionId: unknown; path: unknown; reveal: unknown }) => {
    if ((navigator as unknown as { userActivation?: { isActive: boolean } }).userActivation?.isActive !== true) return Promise.resolve({ error: "Click the link to open it." });
    return ipcRenderer.invoke("apollo:open-file", {
      sessionId: String(request?.sessionId ?? ""),
      path: String(request?.path ?? ""),
      reveal: request?.reveal === true,
    });
  },
});
