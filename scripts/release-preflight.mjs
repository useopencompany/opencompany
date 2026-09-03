#!/usr/bin/env node

// Called by: release workflow checks and root `bun run release:preflight`.
// Purpose: validates required release, web, API, runner, and smoke-check environment variables.

import "./load-env.mjs";
import { inspectLegacySkillCutover } from "./lib/legacy-skill-cutover.mjs";

const groups = {
  web: {
    label: "Vercel web app",
    required: [
      // AppShell still composes shared integration-state readers that
      // resolve through @opencompany/db. Keep this required until #1243's
      // suspect is removed from the web runtime.
      "DATABASE_URL",
      "WORKOS_CLIENT_ID",
      "WORKOS_API_KEY",
      "WORKOS_COOKIE_PASSWORD",
      "WORKOS_COOKIE_DOMAIN",
      "OPENCOMPANY_DESKTOP_AUTH_SECRET",
      "OPENCOMPANY_NEXT_PUBLIC_APP_URL",
      "OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI",
      "RUNNER_PUBLIC_URL",
      "RUNNER_INTERNAL_TOKEN",
      "OPENCOMPANY_API_ORIGIN",
      "NEXT_PUBLIC_OPENCOMPANY_API_ORIGIN",
      "CRON_SECRET",
      // Cached clients may still mint private Brain-asset upload tokens through
      // the retained compatibility route.
      "BLOB_READ_WRITE_TOKEN",
      "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_TOKEN",
      "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_HOST",
      "BETTER_STACK_ERRORS_DSN",
      "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN",
      "OBSERVABILITY_ENABLED",
      "OBSERVABILITY_ENV",
      "NEXT_PUBLIC_OBSERVABILITY_ENABLED",
      "NEXT_PUBLIC_OBSERVABILITY_ENV",
    ],
    optional: [
      "RUNNER_INTERNAL_URL",
      "WORKOS_COOKIE_NAME",
      "RESEND_API_KEY",
      "RESEND_WELCOME_FROM",
      "RESEND_REPLY_TO",
      // Compatibility fallbacks remain code-readable but are not provisioned
      // when the canonical opencompany-specific values above are present.
      "NEXT_PUBLIC_APP_URL",
      "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
      "WORKOS_REDIRECT_URI",
      "NEXT_PUBLIC_ANALYTICS_DEBUG",
      "OBSERVABILITY_RELEASE",
      "OBSERVABILITY_LOG_LEVEL",
      "OBSERVABILITY_TIMING",
      "NEXT_PUBLIC_OBSERVABILITY_RELEASE",
      "NEXT_PUBLIC_OBSERVABILITY_LOG_LEVEL",
      "OPENCOMPANY_OBSERVABILITY_ENABLED",
      "OPENCOMPANY_OTEL_EXPORTER_OTLP_ENDPOINT",
      "OPENCOMPANY_OTEL_EXPORTER_OTLP_HEADERS",
    ],
  },
  api: {
    label: "Render canonical product API",
    required: [
      "API_DATABASE_URL",
      "WORKOS_CLIENT_ID",
      "WORKOS_MOBILE_CLIENT_ID",
      "WORKOS_API_KEY",
      "WORKOS_COOKIE_PASSWORD",
      "WORKOS_COOKIE_DOMAIN",
      "OPENCOMPANY_STRIPE_API_KEY",
      "CRON_SECRET",
      "API_BROWSER_ORIGINS",
      "OPENCOMPANY_API_ORIGIN",
      "OPENCOMPANY_AUTHKIT_DOMAIN",
      "OPENCOMPANY_API_OAUTH_AUDIENCE",
      "VERCEL_AI_GATEWAY_API_KEY",
      "BLOB_READ_WRITE_TOKEN",
      "ELECTRIC_URL",
      "REDIS_URL",
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
      // GitHub App OAuth + webhook ingress (#1203 4a1). The API redirects back
      // to the web origin, so it also needs the canonical app URL.
      "OPENCOMPANY_NEXT_PUBLIC_APP_URL",
      "GITHUB_INTEGRATION_APP_ID",
      "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
      "GITHUB_INTEGRATION_APP_SLUG",
      "GITHUB_INTEGRATION_APP_CLIENT_ID",
      "GITHUB_INTEGRATION_APP_CLIENT_SECRET",
      "GITHUB_INTEGRATION_STATE_SECRET",
      "GITHUB_INTEGRATION_APP_WEBHOOK_SECRET",
      "GITHUB_USER_APP_SLUG",
      "GITHUB_USER_APP_CLIENT_ID",
      "GITHUB_USER_APP_CLIENT_SECRET",
      "GITHUB_USER_APP_STATE_SECRET",
      // Google-family OAuth ingress (#1203 4a2).
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_INTEGRATION_STATE_SECRET",
      // Official Slack MCP plugin OAuth + Linear ingest OAuth/webhook ingress.
      "OPENCOMPANY_SLACK_CLIENT_ID",
      "OPENCOMPANY_SLACK_CLIENT_SECRET",
      "OPENCOMPANY_SLACK_STATE_SECRET",
      "OPENCOMPANY_LINEAR_CLIENT_ID",
      "OPENCOMPANY_LINEAR_CLIENT_SECRET",
      "OPENCOMPANY_LINEAR_WEBHOOK_SECRET",
      "OPENCOMPANY_LINEAR_STATE_SECRET",
      // Remote-MCP, X account, and Slack bot OAuth/webhook ingress.
      "MCP_OAUTH_STATE_SECRET",
      "OPENCOMPANY_X_CLIENT_ID",
      "OPENCOMPANY_X_CLIENT_SECRET",
      "OPENCOMPANY_X_STATE_SECRET",
      "OPENCOMPANY_SLACK_BOT_CLIENT_ID",
      "OPENCOMPANY_SLACK_BOT_CLIENT_SECRET",
      "OPENCOMPANY_SLACK_BOT_SIGNING_SECRET",
      "OPENCOMPANY_SLACK_BOT_STATE_SECRET",
      // Engine auth control calls use the runner's internal transport. The
      // public URL is the guaranteed fallback; the internal URL is optional.
      "RUNNER_PUBLIC_URL",
      "RUNNER_INTERNAL_TOKEN",
      // Validates runner→API wiki calls and first-party plugin MCP tickets.
      // Must match the runner's API_INTERNAL_TOKEN.
      "API_INTERNAL_TOKEN",
      // Billing/usage and Stripe ingress.
      "OPENCOMPANY_STRIPE_WEBHOOK_SECRET",
      "OPENCOMPANY_STRIPE_CHECKOUT_ENABLED",
      "MONID_API_KEY",
    ],
    // Browser profiles are feature-flag gated: the Browserbase credentials are
    // required only when OPENCOMPANY_BROWSER_PROFILES_ENABLED is "true" in this env.
    conditional: [
      {
        when: "OPENCOMPANY_BROWSER_PROFILES_ENABLED",
        equals: "true",
        require: ["BROWSERBASE_API_KEY"],
      },
    ],
    optional: [
      // HubSpot OAuth/webhook ingress (#1203 4c) is code-complete but the
      // HubSpot app is unprovisioned in production; Attio and Jamie verify
      // against per-integration credentials and need no env. Promote these to
      // required when the HubSpot app is set up.
      "OPENCOMPANY_HUBSPOT_CLIENT_ID",
      "OPENCOMPANY_HUBSPOT_CLIENT_SECRET",
      "OPENCOMPANY_HUBSPOT_STATE_SECRET",
      "API_DB_POOL_MAX",
      "WORKOS_COOKIE_NAME",
      "OPENCOMPANY_DEFAULT_CHAT_MODEL",
      "OPENCOMPANY_BROWSER_PROFILES_ENABLED",
      "OPENCOMPANY_BROWSER_PROFILES_KILL_SWITCH",
      "BROWSERBASE_API_KEY",
      "BROWSERBASE_PROJECT_ID",
      "APIFY_API_TOKEN",
      "RUNNER_OPENCOMPANY_BROWSER_ENABLED",
      "OPENCOMPANY_BRAIN_GATEWAY_BASE_URL",
      "OPENCOMPANY_BRAIN_EMBEDDING_MODEL",
      "OPENCOMPANY_BRAIN_VECTOR_MAX_DISTANCE",
      "OPENCOMPANY_MANAGED_CAPABILITIES_KILL_SWITCH",
      "OPENCOMPANY_DISABLED_MANAGED_CAPABILITY_ACTIONS",
      "ELECTRIC_SOURCE_ID",
      "ELECTRIC_SOURCE_SECRET",
      "ELECTRIC_SECRET",
      "ELECTRIC_TOKEN",
      "OBSERVABILITY_ENABLED",
      "OBSERVABILITY_ENV",
      "OBSERVABILITY_RELEASE",
      "OBSERVABILITY_LOG_LEVEL",
      "OBSERVABILITY_TIMING",
      "OPENCOMPANY_OBSERVABILITY_ENABLED",
      "OPENCOMPANY_OTEL_EXPORTER_OTLP_ENDPOINT",
      "OPENCOMPANY_OTEL_EXPORTER_OTLP_HEADERS",
      "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_TOKEN",
      "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_HOST",
      // Retained billing/ingestion compatibility analytics still emit to the
      // generic PostHog project from the API composition root.
      "NEXT_PUBLIC_POSTHOG_TOKEN",
      "NEXT_PUBLIC_POSTHOG_HOST",
      "LATITUDE_API_KEY",
      "LATITUDE_PROJECT_SLUG",
      "LATITUDE_SERVICE_NAME",
      "LATITUDE_TELEMETRY_DISABLED",
      // Sidebar feedback dispatch (#1203 5a1) moved to POST /v1/feedback.
      // Optional (mirrors the retired web behavior): without these, feedback
      // submission fails with a clear error and nothing else degrades.
      "LINEAR_API_KEY",
      "OPENCOMPANY_FEEDBACK_LINEAR_TEAM_ID",
      "OPENCOMPANY_FEEDBACK_LINEAR_LABELS",
      "OPENCOMPANY_FEEDBACK_LINEAR_PROJECT_ID",
      // iMessage pairing (#1203 5a2) moved behind /v1: the API sends the
      // verification text. Optional (mirrors the web group's classification):
      // without a provider, pairing fails with a clear "not configured" error.
      "LINQ_API_TOKEN",
      "LINQ_FROM_NUMBER",
      "LINQ_API_BASE_URL",
      "OPENCOMPANY_IMESSAGE_PROVIDER",
      "OPENCOMPANY_IMESSAGE_KILL_SWITCH",
      // Optional internal-network override for runner control calls.
      "RUNNER_INTERNAL_URL",
    ],
  },
  runner: {
    label: "Render runner",
    required: [
      "DATABASE_URL",
      "RUNNER_INTERNAL_TOKEN",
      // Runner→API canonical origin and bearer for the internal wiki command
      // endpoint. Agent wiki writes fail closed if either is missing.
      "OPENCOMPANY_API_ORIGIN",
      "API_INTERNAL_TOKEN",
      "OPENCOMPANY_NEXT_PUBLIC_APP_URL",
      "RUNNER_STREAM_TOKEN_SECRET",
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
      "RUNNER_ALLOWED_ORIGINS",
      "E2B_API_KEY",
      "VERCEL_AI_GATEWAY_API_KEY",
      "OPENAI_CODEX_API_KEY",
      "BLOB_READ_WRITE_TOKEN",
      "GITHUB_INTEGRATION_APP_ID",
      "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
      "GITHUB_USER_APP_CLIENT_ID",
      "GITHUB_USER_APP_CLIENT_SECRET",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "OPENCOMPANY_X_CLIENT_ID",
      "OPENCOMPANY_X_CLIENT_SECRET",
      "MONID_API_KEY",
      "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_TOKEN",
      "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_HOST",
      "REDIS_URL",
      "RUNNER_OPENCOMPANY_TASK_WORKER_ENABLED",
      "RUNNER_SANDBOX_NAMESPACE",
    ],
    optional: [
      "EXA_API_KEY",
      "APIFY_API_TOKEN",
      "RUNNER_PUBLIC_URL",
      "RUNNER_DATABASE_URL",
      "RUNNER_DB_POOL_MAX",
      "RUNNER_WORKER_CONCURRENCY",
      "RUNNER_JOB_LEASE_TTL_MS",
      "OPENCOMPANY_CODEX_E2B_TEMPLATE",
      "RUNNER_CODEX_MODEL",
      "RUNNER_CODEX_TIMEOUT_MS",
      "RUNNER_CODEX_API_KEY_FALLBACK_ENABLED",
      "RUNNER_OPENCOMPANY_CODEX_CHAT_IDLE_TIMEOUT_MS",
      "RUNNER_OPENCOMPANY_CODEX_CHAT_LEASE_TTL_MS",
      "RUNNER_OPENCOMPANY_BROWSER_ENABLED",
      "RUNNER_INSTANCE_ID",
      "RUNNER_PREVIEW_BASE_DOMAIN",
      "RUNNER_PREVIEW_PROTOCOL",
      "OPENCOMPANY_BRAIN_GATEWAY_BASE_URL",
      "OPENCOMPANY_BRAIN_EMBEDDING_MODEL",
      "OPENCOMPANY_BRAIN_VECTOR_MAX_DISTANCE",
      "OPENCOMPANY_CHAT_ACTIONS_KILL_SWITCH",
      "OPENCOMPANY_CHAT_SANDBOX_IMAGE",
      "OPENCOMPANY_MANAGED_CAPABILITIES_KILL_SWITCH",
      "OPENCOMPANY_DISABLED_MANAGED_CAPABILITY_ACTIONS",
      "OPENCOMPANY_REVOLUT_BUSINESS_WORKSPACE_ID",
      "OPENCOMPANY_REVOLUT_BUSINESS_API_TOKEN",
      "OPENCOMPANY_REVOLUT_BUSINESS_ACCOUNT_LABEL",
      "OPENCOMPANY_REVOLUT_BUSINESS_API_BASE_URL",
      "OPENCOMPANY_HUBSPOT_CLIENT_ID",
      "OPENCOMPANY_HUBSPOT_CLIENT_SECRET",
      "OPENCOMPANY_DICTATION_REALTIME_MODEL",
      "OPENCOMPANY_DICTATION_FINAL_MODEL",
      "OPENAI_API_KEY",
      "BETTER_STACK_ERRORS_DSN",
      "OBSERVABILITY_ENABLED",
      "OBSERVABILITY_ENV",
      "OBSERVABILITY_RELEASE",
      "OBSERVABILITY_LOG_LEVEL",
      "OBSERVABILITY_TIMING",
      "BRAINTRUST_ENABLED",
      "BRAINTRUST_API_KEY",
      "BRAINTRUST_PROJECT_ID",
      "BRAINTRUST_PROJECT_NAME",
      "OPENCOMPANY_OBSERVABILITY_ENABLED",
      "OPENCOMPANY_OTEL_EXPORTER_OTLP_ENDPOINT",
      "OPENCOMPANY_OTEL_EXPORTER_OTLP_HEADERS",
      "LINQ_API_TOKEN",
      "LINQ_FROM_NUMBER",
      "LINQ_API_BASE_URL",
      "OPENCOMPANY_IMESSAGE_PROVIDER",
      "OPENCOMPANY_IMESSAGE_KILL_SWITCH",
      "OPENCOMPANY_IMESSAGE_DAILY_CAP",
      "LATITUDE_API_KEY",
      "LATITUDE_PROJECT_SLUG",
      "LATITUDE_SERVICE_NAME",
      "LATITUDE_TELEMETRY_DISABLED",
      // Retained ingestion analytics still emit to the generic PostHog project.
      "NEXT_PUBLIC_POSTHOG_TOKEN",
      "NEXT_PUBLIC_POSTHOG_HOST",
    ],
  },
  release: {
    label: "GitHub Actions release automation",
    required: [
      "PRODUCTION_DATABASE_URL",
      "VERCEL_TOKEN",
      "VERCEL_ORG_ID",
      "OPENCOMPANY_VERCEL_PROJECT_ID",
      "MARKETING_VERCEL_PROJECT_ID",
      "RENDER_SERVICE_ID",
      "RENDER_API_SERVICE_ID",
      "RENDER_API_KEY",
      "PRODUCTION_OPENCOMPANY_URL",
      "PRODUCTION_API_URL",
      "RUNNER_PUBLIC_URL",
    ],
    optional: [],
  },
};

// Vercel projects whose env this script can verify against API metadata when a
// value is unreadable locally. Secrets are managed in Infisical and synced to
// Vercel; a sync (or a hand edit) can mark a var "sensitive", which makes
// `vercel env pull` return it EMPTY even though Vercel still injects it at
// build and runtime. Presence in project metadata is therefore the truth for
// "is it set" — readability is not required for the deploy to work.
const VERCEL_PROJECT_BY_GROUP = {
  web: process.env.OPENCOMPANY_VERCEL_PROJECT_ID,
};

async function vercelProductionEnvKeys(projectId) {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_ORG_ID;
  if (!token || !teamId || !projectId) return null;
  try {
    const response = await fetch(
      `https://api.vercel.com/v9/projects/${projectId}/env?teamId=${teamId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) return null;
    const body = await response.json();
    return new Set(
      (body.envs ?? [])
        .filter((env) => (env.target ?? []).includes("production"))
        .map((env) => env.key),
    );
  } catch {
    return null;
  }
}

const selected = selectGroups();
let failed = false;

for (const name of selected) {
  const group = groups[name];
  let missing = group.required.filter((key) => isUnset(process.env[key]));
  let unreadable = [];
  if (missing.length > 0 && VERCEL_PROJECT_BY_GROUP[name]) {
    const remoteKeys = await vercelProductionEnvKeys(VERCEL_PROJECT_BY_GROUP[name]);
    if (remoteKeys) {
      unreadable = missing.filter((key) => remoteKeys.has(key));
      missing = missing.filter((key) => !remoteKeys.has(key));
    }
  }
  const placeholders = group.required.filter((key) => isPlaceholder(process.env[key]));
  const optionalMissing = group.optional.filter((key) => isUnset(process.env[key]));
  const conditionalMissing = (group.conditional ?? []).flatMap((rule) =>
    (process.env[rule.when]?.trim() ?? "") === rule.equals
      ? rule.require.filter((key) => isUnset(process.env[key]))
      : [],
  );

  console.log(`\n${group.label}`);
  console.log(`  required: ${group.required.length - missing.length}/${group.required.length} set`);

  if (unreadable.length > 0) {
    console.log(
      `  set on Vercel but unreadable locally (sensitive type): ${unreadable.join(", ")}`,
    );
  }

  if (missing.length > 0) {
    failed = true;
    console.log(`  missing: ${missing.join(", ")}`);
  }

  if (placeholders.length > 0) {
    failed = true;
    console.log(`  placeholders: ${placeholders.join(", ")}`);
  }

  if (conditionalMissing.length > 0) {
    failed = true;
    console.log(
      `  missing while the gating feature flag is enabled: ${conditionalMissing.join(", ")}`,
    );
  }

  if (optionalMissing.length > 0) {
    console.log(`  optional unset: ${optionalMissing.join(", ")}`);
  }
}

if (
  selected.includes("release") &&
  !isUnset(process.env.PRODUCTION_DATABASE_URL) &&
  !isPlaceholder(process.env.PRODUCTION_DATABASE_URL)
) {
  try {
    const cutover = await inspectLegacySkillCutover(process.env.PRODUCTION_DATABASE_URL);
    console.log("\nLegacy Agent Skills cutover");
    console.log(
      `  goat.skills rows: ${cutover.skillRows}${cutover.skillsTablePresent ? "" : " (table already dropped)"}`,
    );
    console.log(
      `  goat.chat_session_skills rows: ${cutover.chatSessionSkillRows}${cutover.chatSessionSkillsTablePresent ? "" : " (table already dropped)"}`,
    );
    console.log(
      `  queued/running Workflow Tasks containing skillSnapshots: ${cutover.legacySkillSnapshotTasks}`,
    );
    console.log(
      `  queued/running Workflow Tasks missing step skillBundleIds arrays: ${cutover.missingSkillBundleIdTasks}`,
    );
    console.log(
      `  queued/running legacy-dependent Workflow Tasks (deduplicated): ${cutover.legacyDependentTasks}`,
    );
    if (cutover.legacyDependentTasks > 0) {
      failed = true;
      console.log(
        "  complete or cancel every legacy-dependent Workflow Task before deploying this cutover.",
      );
    }
  } catch (error) {
    failed = true;
    console.log("\nLegacy Agent Skills cutover");
    console.log(
      `  inspection failed: ${error instanceof Error ? error.message : "unknown Postgres error"}`,
    );
  }
}

if (selected.includes("runner")) {
  const latitudeApiKeySet = !isUnset(process.env.LATITUDE_API_KEY);
  const latitudeProjectSet = !isUnset(process.env.LATITUDE_PROJECT_SLUG);
  if (latitudeApiKeySet !== latitudeProjectSet) {
    failed = true;
    console.log(
      "\nLATITUDE_API_KEY and LATITUDE_PROJECT_SLUG must either both be set or both be unset.",
    );
  }
  if (process.env.RUNNER_OPENCOMPANY_TASK_WORKER_ENABLED?.trim().toLowerCase() !== "true") {
    failed = true;
    console.log("\nRUNNER_OPENCOMPANY_TASK_WORKER_ENABLED must be true in the production runner.");
  }
}

const cookiePassword = process.env.WORKOS_COOKIE_PASSWORD;
if (!isUnset(cookiePassword) && cookiePassword.length < 32) {
  failed = true;
  console.log("\nWORKOS_COOKIE_PASSWORD must be at least 32 characters.");
}

const desktopAuthSecret = process.env.OPENCOMPANY_DESKTOP_AUTH_SECRET?.trim();
if (desktopAuthSecret && !isBase64Encoded32ByteKey(desktopAuthSecret)) {
  failed = true;
  console.log("\nOPENCOMPANY_DESKTOP_AUTH_SECRET must be a base64-encoded 32-byte key.");
}

const githubIntegrationStateSecret = process.env.GITHUB_INTEGRATION_STATE_SECRET;
if (!isUnset(githubIntegrationStateSecret) && githubIntegrationStateSecret.length < 32) {
  failed = true;
  console.log("\nGITHUB_INTEGRATION_STATE_SECRET must be at least 32 characters.");
}

const githubUserAppStateSecret = process.env.GITHUB_USER_APP_STATE_SECRET;
if (!isUnset(githubUserAppStateSecret) && githubUserAppStateSecret.length < 32) {
  failed = true;
  console.log("\nGITHUB_USER_APP_STATE_SECRET must be at least 32 characters.");
}

const webRedirectUri = process.env.OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI;
if (
  webRedirectUri &&
  !webRedirectUri.startsWith("https://") &&
  !webRedirectUri.includes("localhost")
) {
  failed = true;
  console.log(
    "\nOPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI should be https:// outside local development.",
  );
}

if (selected.includes("web") && !isUnset(process.env.NEXT_PUBLIC_OPENCOMPANY_API_ORIGIN)) {
  const configuredApiOrigin = httpOrigin(process.env.NEXT_PUBLIC_OPENCOMPANY_API_ORIGIN);
  const expectedApiOrigin = httpOrigin(process.env.PRODUCTION_API_URL);
  if (!configuredApiOrigin || (expectedApiOrigin && configuredApiOrigin !== expectedApiOrigin)) {
    failed = true;
    console.log("\nNEXT_PUBLIC_OPENCOMPANY_API_ORIGIN must match the production API HTTPS origin.");
  }
}

if (selected.includes("api") && !isUnset(process.env.API_BROWSER_ORIGINS)) {
  const browserOrigins = process.env.API_BROWSER_ORIGINS.split(",").map((value) =>
    httpOrigin(value),
  );
  const expectedWebOrigin = httpOrigin(process.env.PRODUCTION_OPENCOMPANY_URL);
  if (
    browserOrigins.some((origin) => !origin) ||
    (expectedWebOrigin && !browserOrigins.includes(expectedWebOrigin))
  ) {
    failed = true;
    console.log("\nAPI_BROWSER_ORIGINS must contain the production web HTTPS origin.");
  }
}

if (selected.some((name) => name === "web" || name === "api")) {
  const cookieDomain = process.env.WORKOS_COOKIE_DOMAIN?.trim().replace(/^\./u, "");
  const webHostname = hostname(process.env.PRODUCTION_OPENCOMPANY_URL);
  const apiHostname = hostname(process.env.PRODUCTION_API_URL);
  if (
    cookieDomain &&
    ((webHostname && !hostnameUsesDomain(webHostname, cookieDomain)) ||
      (apiHostname && !hostnameUsesDomain(apiHostname, cookieDomain)))
  ) {
    failed = true;
    console.log("\nWORKOS_COOKIE_DOMAIN must cover the production web and API hostnames.");
  }
}

if (failed) {
  console.log("\nRelease preflight failed.");
  process.exit(1);
}

console.log("\nRelease preflight passed.");

function selectGroups() {
  const args = process.argv.slice(2);
  const requested = args
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => arg.slice(2))
    .filter((arg) => groups[arg]);

  return requested.length > 0 ? requested : ["web", "api", "runner", "release"];
}

function isBase64Encoded32ByteKey(value) {
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(value) && Buffer.from(value, "base64").length === 32;
}

function isUnset(value) {
  return !value || value.trim() === "";
}

function isPlaceholder(value) {
  if (isUnset(value)) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "..." ||
    normalized.includes("replace-with") ||
    normalized.includes("your-") ||
    normalized.endsWith("_placeholder") ||
    normalized === "postgresql://..."
  );
}

function httpOrigin(value) {
  if (isUnset(value)) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function hostname(value) {
  const origin = httpOrigin(value);
  return origin ? new URL(origin).hostname : null;
}

function hostnameUsesDomain(hostnameValue, domain) {
  return hostnameValue === domain || hostnameValue.endsWith(`.${domain}`);
}
