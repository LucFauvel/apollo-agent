import { defineConfig } from "vitest/config";

// Only the scripts and src/ have tests; release/ and build/ hold packaged copies of other code.
// End-to-end tests (*.e2e.test.ts) spawn real processes for seconds; they run on their own with
// `pnpm test:e2e` (CI runs both), so they never slow the parallel `pnpm test` into timeouts.
export default defineConfig({
  test: process.env.APOLLO_E2E
    ? { include: ["scripts/**/*.e2e.test.ts"] }
    : { include: ["scripts/**/*.test.ts", "src/**/*.test.ts"], exclude: ["scripts/**/*.e2e.test.ts", "**/node_modules/**"] },
});
