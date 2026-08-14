import { defineConfig } from "vitest/config";

// The CLI tests spawn real processes; vitest's 5s default flakes on the
// isolated PR-gate runner, so give this package a generous ceiling.
export default defineConfig({
  test: { testTimeout: 30_000 },
});
