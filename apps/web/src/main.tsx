import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { AuthGate } from "./auth.tsx";
import "./index.css";

// The desktop app hides the macOS title bar: headers become drag regions and
// the sidebar leaves room for the window buttons.
if (/Electron\//.test(navigator.userAgent) && /Mac/.test(navigator.platform)) {
  document.documentElement.classList.add("titlebar-hidden");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
