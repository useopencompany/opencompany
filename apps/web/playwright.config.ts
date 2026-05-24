import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `bun run dev -- --hostname 127.0.0.1 --port ${port}`,
    cwd: ".",
    env: {
      DATABASE_URL: "postgresql://user:password@localhost:5432/opencompany_test",
      WORKOS_CLIENT_ID: "client_test",
      WORKOS_API_KEY: "sk_test_placeholder",
      WORKOS_COOKIE_PASSWORD: "test-cookie-password-at-least-32-chars",
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: `http://127.0.0.1:${port}/auth/callback`,
      OPENCOMPANY_NGROK_DISABLED: "1",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
