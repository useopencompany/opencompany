import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@opencompany\/db\/client$/,
        replacement: new URL("../../packages/db/src/client.ts", import.meta.url).pathname,
      },
      {
        find: /^@opencompany\/db\/schema$/,
        replacement: new URL("../../packages/db/src/schema.ts", import.meta.url).pathname,
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
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    clearMocks: true,
  },
});
