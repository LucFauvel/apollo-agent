import { defineConfig } from "vitest/config";

// Only the scripts have tests; release/ and build/ hold packaged copies of other code.
export default defineConfig({ test: { include: ["scripts/**/*.test.ts"] } });
