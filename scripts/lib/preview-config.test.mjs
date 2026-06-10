import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildManifest,
  electricServiceEnv,
  isExpired,
  PREVIEW_TAG,
  previewNames,
  runnerServiceEnv,
  toDirectConnectionString,
  webDeployEnv,
} from "./preview-config.mjs";

test("previewNames is deterministic from the PR number", () => {
  const names = previewNames(42, { baseDomain: "preview.opencompany.cloud" });
  assert.equal(names.pr, 42);
  assert.equal(names.neonBranch, "preview/pr-42");
  assert.equal(names.runnerService, "oc-preview-pr-42-runner");
  assert.equal(names.electricService, "oc-preview-pr-42-electric");
  assert.equal(names.streamsService, "oc-preview-pr-42-streams");
  assert.equal(names.prTag, "pr-42");
  assert.equal(names.alias, "pr-42.preview.opencompany.cloud");
  assert.equal(names.aliasUrl, "https://pr-42.preview.opencompany.cloud");
  assert.equal(names.redirectUri, "https://pr-42.preview.opencompany.cloud/auth/callback");
});

test("previewNames strips protocol/trailing slash from the base domain", () => {
  const names = previewNames("7", { baseDomain: "https://preview.opencompany.cloud/" });
  assert.equal(names.alias, "pr-7.preview.opencompany.cloud");
});

test("previewNames omits alias fields when no base domain", () => {
  const names = previewNames(1);
  assert.equal(names.alias, undefined);
  assert.equal(names.redirectUri, undefined);
});

test("previewNames rejects invalid PR numbers", () => {
  assert.throws(() => previewNames(0));
  assert.throws(() => previewNames(-3));
  assert.throws(() => previewNames("abc"));
});

test("toDirectConnectionString strips the -pooler label", () => {
  assert.equal(
    toDirectConnectionString(
      "postgresql://ep-cool-123-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require",
    ),
    "postgresql://ep-cool-123.eu-central-1.aws.neon.tech/neondb?sslmode=require",
  );
});

test("toDirectConnectionString leaves a direct url unchanged", () => {
  const direct = "postgresql://ep-cool-123.eu-central-1.aws.neon.tech/neondb";
  assert.equal(toDirectConnectionString(direct), direct);
});

test("webDeployEnv wires per-PR cross-service vars and drops empties", () => {
  const env = webDeployEnv({
    pr: 42,
    sha: "abc1234",
    databaseUrl: "postgresql://pooled",
    appUrl: "https://pr-42.preview.opencompany.cloud",
    runnerUrl: "https://oc-preview-pr-42-runner.onrender.com",
    runnerInternalToken: "tok",
    electricUrl: "https://oc-preview-pr-42-electric.onrender.com",
    electricSecret: "sek",
    streamsUrl: "https://oc-preview-pr-42-streams.onrender.com",
    streamsToken: undefined, // optional → dropped
    redirectUri: "https://pr-42.preview.opencompany.cloud/auth/callback",
  });
  assert.equal(env.DATABASE_URL, "postgresql://pooled");
  assert.equal(env.RUNNER_INTERNAL_URL, env.RUNNER_PUBLIC_URL);
  assert.equal(env.ELECTRIC_SECRET, "sek");
  assert.equal(
    env.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
    "https://pr-42.preview.opencompany.cloud/auth/callback",
  );
  assert.equal(env.NEXT_PUBLIC_APP_URL, "https://pr-42.preview.opencompany.cloud");
  assert.equal(env.INNGEST_ENV, "preview-pr-42");
  assert.equal(env.INNGEST_SERVE_ORIGIN, "https://pr-42.preview.opencompany.cloud");
  assert.equal(env.OBSERVABILITY_ENV, "preview");
  assert.equal(env.NEXT_PUBLIC_OBSERVABILITY_RELEASE, "abc1234");
  // Server-side OBSERVABILITY_RELEASE stays unset (manual-override-only convention).
  assert.ok(!("OBSERVABILITY_RELEASE" in env));
  assert.equal(env.PREVIEW_PR_NUMBER, "42");
  assert.ok(!("DURABLE_STREAMS_TOKEN" in env));
});

test("runnerServiceEnv carries the preview-identity trio + direct DB + neon creds", () => {
  const env = runnerServiceEnv({
    pr: 42,
    directDatabaseUrl: "postgresql://direct",
    neonBranchId: "br-xyz",
    neonProjectId: "proj-1",
    neonApiKey: "neon-key",
    runnerInternalToken: "tok",
    runnerStreamTokenSecret: "stream-secret",
    runnerRuntimeEnv: {
      E2B_API_KEY: "e2b-key",
      VERCEL_AI_GATEWAY_API_KEY: "gateway-key",
      INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: "encryption-key",
      DATABASE_URL: "postgresql://prod",
      RUNNER_ALLOWED_ORIGINS: "https://prod.example.com",
      OBSERVABILITY_ENV: "production",
    },
    streamsUrl: "https://streams",
    allowedOrigins: "https://pr-42.preview.opencompany.cloud",
  });
  assert.equal(env.PREVIEW_ENV, "true");
  assert.equal(env.PREVIEW_PR_NUMBER, "42");
  assert.equal(env.NEON_BRANCH_ID, "br-xyz");
  assert.equal(env.NEON_API_KEY, "neon-key");
  assert.equal(env.DATABASE_URL, "postgresql://direct");
  assert.equal(env.RUNNER_DATABASE_URL, "postgresql://direct");
  assert.equal(env.RUNNER_INTERNAL_TOKEN, "tok");
  assert.equal(env.RUNNER_STREAM_TOKEN_SECRET, "stream-secret");
  assert.equal(env.E2B_API_KEY, "e2b-key");
  assert.equal(env.VERCEL_AI_GATEWAY_API_KEY, "gateway-key");
  assert.equal(env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY, "encryption-key");
  assert.equal(env.RUNNER_WORKER_CONCURRENCY, "2");
  assert.equal(env.RUNNER_DB_POOL_MAX, "5");
  assert.equal(env.RUNNER_ALLOWED_ORIGINS, "https://pr-42.preview.opencompany.cloud");
  assert.equal(env.OBSERVABILITY_ENV, "preview");
});

test("electricServiceEnv sets secure mode + direct DB; drops empty storage dir", () => {
  const env = electricServiceEnv({
    directDatabaseUrl: "postgresql://direct",
    electricSecret: "sek",
  });
  assert.equal(env.DATABASE_URL, "postgresql://direct");
  assert.equal(env.ELECTRIC_SECRET, "sek");
  assert.ok(!("ELECTRIC_STORAGE_DIR" in env));

  const withStorage = electricServiceEnv({
    directDatabaseUrl: "postgresql://direct",
    electricSecret: "sek",
    storageDir: "/data/electric",
  });
  assert.equal(withStorage.ELECTRIC_STORAGE_DIR, "/data/electric");
});

test("buildManifest stamps the tag + pr and drops empties", () => {
  const m = buildManifest({
    pr: 42,
    sha: "abc1234",
    createdAt: "2026-06-06T12:00:00Z",
    neonBranchId: "br-xyz",
    runnerServiceId: "srv-1",
    electricServiceId: undefined,
    ttlHours: 72,
  });
  assert.equal(m.tag, PREVIEW_TAG);
  assert.equal(m.pr, 42);
  assert.equal(m.ttlHours, 72);
  assert.ok(!("electricServiceId" in m));
});

test("isExpired respects ttl and disabled ttl", () => {
  const created = "2026-06-06T00:00:00Z";
  const now = Date.parse("2026-06-06T00:00:00Z");
  assert.equal(isExpired(created, 24, now + 25 * 3600 * 1000), true);
  assert.equal(isExpired(created, 24, now + 23 * 3600 * 1000), false);
  assert.equal(isExpired(created, 0, now + 1000 * 3600 * 1000), false);
  assert.equal(isExpired("not-a-date", 24, now), false);
});
