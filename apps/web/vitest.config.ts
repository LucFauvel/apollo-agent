import { defineConfig } from "vitest/config";

// Logic-level tests only (no DOM environment): components render with react-dom/server.
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
