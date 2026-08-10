import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWebDevEnv } from "./web-dev-env.mjs";

test("web local HTTPS WorkOS redirect wins over the ngrok tunnel", () => {
  const env = resolveWebDevEnv({
    port: "3002",
    processEnv: {
      RUNNER_ALLOWED_ORIGINS: "https://existing.example",
    },
    tunnelEnv: {
      NEXT_PUBLIC_APP_URL: "https://public.ngrok-free.app",
      GOAT_NEXT_PUBLIC_APP_URL: "https://public.ngrok-free.app",
      GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://public.ngrok-free.app/auth/callback",
    },
    webHttpsEnv: {
      GOAT_NEXT_PUBLIC_APP_URL: "https://localhost:3443",
      GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://localhost:3443/auth/callback",
    },
  });

  assert.equal(env.GOAT_NEXT_PUBLIC_APP_URL, "https://localhost:3443");
  assert.equal(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI, "https://localhost:3443/auth/callback");
  assert.equal(
    env.RUNNER_ALLOWED_ORIGINS,
    "https://existing.example,https://localhost:3443,https://public.ngrok-free.app",
  );
  assert.equal(env.RUNNER_PREVIEW_BASE_DOMAIN, "preview.localhost:3443");
  assert.equal(env.RUNNER_PREVIEW_PROTOCOL, "https");
});

test("web redirect falls back to localhost when Caddy is unavailable", () => {
  const env = resolveWebDevEnv({
    port: "3002",
    processEnv: {
      GOAT_NEXT_PUBLIC_APP_URL: "https://localhost:3443",
      GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://localhost:3443/auth/callback",
    },
    tunnelEnv: {
      NEXT_PUBLIC_APP_URL: "https://public.ngrok-free.app",
      GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://public.ngrok-free.app/auth/callback",
    },
  });

  assert.equal(env.GOAT_NEXT_PUBLIC_APP_URL, "https://public.ngrok-free.app");
  assert.equal(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI, "http://localhost:3002/auth/callback");
  assert.equal(env.RUNNER_PREVIEW_BASE_DOMAIN, "preview.localhost:3040");
  assert.equal(env.RUNNER_PREVIEW_PROTOCOL, "http");
});
