import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
        },
      },
      {
        test: {
          name: "pglite",
          include: ["src/**/*.integration.test.ts"],
          // Parallel startup under Bun intermittently traps inside PGlite's WASM runtime before a
          // test can run. Keep the database-backed files serial while unit tests stay parallel.
          fileParallelism: false,
        },
      },
    ],
  },
});
