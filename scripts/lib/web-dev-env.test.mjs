import assert from "node:assert/strict";
import { test } from "node:test";
import { localSandboxNamespace } from "./sandbox-namespace.mjs";
import { resolveWebDevEnv } from "./web-dev-env.mjs";

test("web local HTTPS WorkOS redirect wins over the ngrok tunnel", () => {
  const env = resolveWebDevEnv({
    port: "3002",
    processEnv: {
      RUNNER_ALLOWED_ORIGINS: "https://existing.example",
      RUNNER_SANDBOX_NAMESPACE: "production",
    },
    tunnelEnv: {
      NEXT_PUBLIC_APP_URL: "https://public.ngrok-free.app",
      OPENCOMPANY_NEXT_PUBLIC_APP_URL: "https://public.ngrok-free.app",
      OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://public.ngrok-free.app/auth/callback",
    },
    webHttpsEnv: {
      OPENCOMPANY_NEXT_PUBLIC_APP_URL: "https://localhost:3443",
      OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://localhost:3443/auth/callback",
    },
    workspacePath: "/workspaces/local-one",
  });

  assert.equal(env.OPENCOMPANY_NEXT_PUBLIC_APP_URL, "https://localhost:3443");
  assert.equal(env.OPENCOMPANY_API_ORIGIN, "http://localhost:3001");
  assert.equal(env.API_BROWSER_ORIGINS, "https://localhost:3443,https://public.ngrok-free.app");
  assert.equal(env.NODE_USE_SYSTEM_CA, "1");
  assert.equal(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI, "https://localhost:3443/auth/callback");
  assert.equal(
    env.RUNNER_ALLOWED_ORIGINS,
    "https://existing.example,https://localhost:3443,https://public.ngrok-free.app",
  );
  assert.equal(env.RUNNER_PREVIEW_BASE_DOMAIN, "preview.localhost:3443");
  assert.equal(env.RUNNER_PREVIEW_PROTOCOL, "https");
  assert.equal(env.RUNNER_SANDBOX_NAMESPACE, localSandboxNamespace("/workspaces/local-one"));
  assert.notEqual(env.RUNNER_SANDBOX_NAMESPACE, "production");
});

test("web redirect falls back to localhost when Caddy is unavailable", () => {
  const env = resolveWebDevEnv({
    port: "3002",
    processEnv: {
      OPENCOMPANY_NEXT_PUBLIC_APP_URL: "https://localhost:3443",
      OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://localhost:3443/auth/callback",
    },
    tunnelEnv: {
      NEXT_PUBLIC_APP_URL: "https://public.ngrok-free.app",
      OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://public.ngrok-free.app/auth/callback",
    },
  });

  assert.equal(env.OPENCOMPANY_NEXT_PUBLIC_APP_URL, "https://public.ngrok-free.app");
  assert.equal(env.OPENCOMPANY_API_ORIGIN, "http://localhost:3001");
  assert.equal(env.NODE_USE_SYSTEM_CA, undefined);
  assert.equal(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI, "http://localhost:3002/auth/callback");
  assert.equal(env.RUNNER_PREVIEW_BASE_DOMAIN, "preview.localhost:3040");
  assert.equal(env.RUNNER_PREVIEW_PROTOCOL, "http");
});

test("web dev preserves the API origin selected for an isolated workspace", () => {
  const env = resolveWebDevEnv({
    processEnv: {
      OPENCOMPANY_API_ORIGIN: "http://localhost:55014",
      OPENCOMPANY_NEXT_PUBLIC_APP_URL: "https://localhost:55012",
    },
    webHttpsEnv: {
      OPENCOMPANY_NEXT_PUBLIC_APP_URL: "https://localhost:55012",
      OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://localhost:55012/auth/callback",
    },
  });

  assert.equal(env.OPENCOMPANY_API_ORIGIN, "http://localhost:55014");
  assert.equal(env.API_BROWSER_ORIGINS, "https://localhost:55012");
});
