import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^server-only$/,
        replacement: new URL("./test/server-only.ts", import.meta.url).pathname,
      },
      {
        find: /^@opencompany\/db\/client$/,
        replacement: new URL("../../packages/db/src/client.ts", import.meta.url).pathname,
      },
      {
        find: /^@opencompany\/db\/goat-schema$/,
        replacement: new URL("../../packages/db/src/goat-schema.ts", import.meta.url).pathname,
      },
      {
        find: /^@opencompany\/db$/,
        replacement: new URL("../../packages/db/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@",
        replacement: new URL(".", import.meta.url).pathname,
      },
    ],
  },
  test: {
    globals: true,
    clearMocks: true,
    // AuthKit's ESM build imports extensionless Next.js subpaths. Inline it so
    // Vite resolves those framework entry points instead of native Node.
    server: {
      deps: {
        inline: ["@workos-inc/authkit-nextjs"],
      },
    },
    // userEvent-driven component tests can exceed the 5s default under CI load.
    testTimeout: 15000,
    hookTimeout: 15000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["**/*.{test,spec}.?(c|m)[jt]s"],
          exclude: ["node_modules/**", ".next/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["**/*.{test,spec}.?(c|m)[jt]sx"],
          exclude: ["node_modules/**", ".next/**"],
        },
      },
    ],
  },
});
