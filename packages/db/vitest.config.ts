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
          // Each file owns its own in-memory PGlite instance, so files are independent and run in
          // parallel. The historical WASM startup trap was specific to Bun-backed workers; both CI
          // and `bun run test` launch Vitest on Node, which forks these workers safely.
          fileParallelism: true,
          // Every test builds a schema from the migration files before it asserts, which is real
          // work that slows down under load. Vitest's 5s default is a CPU-contention tripwire
          // rather than a useful bound here; unit tests keep the strict default.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
