import { defineConfig } from "vitest/config";

// The integration suites boot a fresh PGlite per file and replay the full
// migration history in beforeEach; vitest's 10s hook default tears that
// setup on slow runners, and the half-migrated instance then cascades into
// "already exists" failures. Give hooks and tests a generous ceiling.
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 120_000 },
});
