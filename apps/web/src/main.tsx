import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { AuthGate } from "./auth.tsx";
import "./index.css";

// The desktop app hides the title bar on macOS and Windows: headers become drag regions and
// leave room for the window buttons (traffic lights on the left, caption buttons on the right).
if (/Electron\//.test(navigator.userAgent)) {
  if (/Mac/.test(navigator.platform)) document.documentElement.classList.add("titlebar-hidden", "titlebar-mac");
  else if (/Win/.test(navigator.platform)) document.documentElement.classList.add("titlebar-hidden", "titlebar-windows");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
