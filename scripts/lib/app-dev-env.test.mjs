import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDevEnv } from "./app-dev-env.mjs";

test("Goat local HTTPS WorkOS redirect wins over the ngrok tunnel", () => {
  const env = resolveDevEnv({
    port: "3002",
    processEnv: {
      RUNNER_ALLOWED_ORIGINS: "https://existing.example",
    },
    tunnelEnv: {
      NEXT_PUBLIC_APP_URL: "https://public.ngrok-free.app",
      NEXT_PUBLIC_APP_URL: "https://public.ngrok-free.app",
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://public.ngrok-free.app/auth/callback",
    },
    httpsEnv: {
      NEXT_PUBLIC_APP_URL: "https://localhost:3443",
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://localhost:3443/auth/callback",
    },
  });

  assert.equal(env.NEXT_PUBLIC_APP_URL, "https://localhost:3443");
  assert.equal(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI, "https://localhost:3443/auth/callback");
  assert.equal(
    env.RUNNER_ALLOWED_ORIGINS,
    "https://existing.example,https://localhost:3443,https://public.ngrok-free.app",
  );
  assert.equal(env.RUNNER_PREVIEW_BASE_DOMAIN, "preview.localhost:3443");
  assert.equal(env.RUNNER_PREVIEW_PROTOCOL, "https");
});

test("Goat redirect falls back to localhost when Caddy is unavailable", () => {
  const env = resolveDevEnv({
    port: "3002",
    processEnv: {
      NEXT_PUBLIC_APP_URL: "https://localhost:3443",
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://localhost:3443/auth/callback",
    },
    tunnelEnv: {
      NEXT_PUBLIC_APP_URL: "https://public.ngrok-free.app",
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://public.ngrok-free.app/auth/callback",
    },
  });

  assert.equal(env.NEXT_PUBLIC_APP_URL, "https://public.ngrok-free.app");
  assert.equal(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI, "http://localhost:3002/auth/callback");
  assert.equal(env.RUNNER_PREVIEW_BASE_DOMAIN, "preview.localhost:3040");
  assert.equal(env.RUNNER_PREVIEW_PROTOCOL, "http");
});
