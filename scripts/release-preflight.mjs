#!/usr/bin/env node

// Called by: release workflow checks and root `bun run release:preflight`.
// Purpose: validates required release, web, API, runner, and smoke-check environment variables.

import "./load-env.mjs";

const groups = {
  web: {
    label: "Vercel web app",
    required: [
      "DATABASE_URL",
      "WORKOS_CLIENT_ID",
      "WORKOS_API_KEY",
      "WORKOS_COOKIE_PASSWORD",
      "WORKOS_COOKIE_DOMAIN",
      "GOAT_NEXT_PUBLIC_APP_URL",
      "GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI",
      "GOAT_AUTHKIT_DOMAIN",
      "VERCEL_AI_GATEWAY_API_KEY",
      "BLOB_READ_WRITE_TOKEN",
      "RUNNER_PUBLIC_URL",
      "RUNNER_INTERNAL_TOKEN",
      "GOAT_API_ORIGIN",
      "NEXT_PUBLIC_GOAT_API_ORIGIN",
      "NEXT_PUBLIC_GOAT_HEADLESS_CHAT",
      "ELECTRIC_URL",
      "MONID_API_KEY",
      "GOAT_STRIPE_API_KEY",
      "GOAT_STRIPE_WEBHOOK_SECRET",
      "GOAT_STRIPE_CHECKOUT_ENABLED",
      "GOAT_X_CLIENT_ID",
      "GOAT_X_CLIENT_SECRET",
      "GOAT_X_STATE_SECRET",
      "CRON_SECRET",
      "NEXT_PUBLIC_GOAT_POSTHOG_TOKEN",
      "NEXT_PUBLIC_GOAT_POSTHOG_HOST",
    ],
    optional: [
      "RUNNER_INTERNAL_URL",
      "EXA_API_KEY",
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
      "MCP_OAUTH_STATE_SECRET",
      "RESEND_API_KEY",
      "RESEND_WELCOME_FROM",
      "RESEND_REPLY_TO",
      "GITHUB_INTEGRATION_APP_ID",
      "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
      "GITHUB_INTEGRATION_APP_SLUG",
      "GITHUB_INTEGRATION_APP_CLIENT_ID",
      "GITHUB_INTEGRATION_APP_CLIENT_SECRET",
      "GITHUB_INTEGRATION_STATE_SECRET",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_INTEGRATION_STATE_SECRET",
      "ELECTRIC_SOURCE_ID",
      "ELECTRIC_SOURCE_SECRET",
      "ELECTRIC_SECRET",
      "ELECTRIC_TOKEN",
      "GOAT_OBSERVABILITY_ENABLED",
      "GOAT_OTEL_EXPORTER_OTLP_ENDPOINT",
      "GOAT_OTEL_EXPORTER_OTLP_HEADERS",
      "GOAT_CHAT_ACTIONS_KILL_SWITCH",
      "GOAT_CHAT_SANDBOX_IMAGE",
      "LINQ_API_TOKEN",
      "LINQ_FROM_NUMBER",
      "LINQ_API_BASE_URL",
      "GOAT_IMESSAGE_PROVIDER",
      "GOAT_IMESSAGE_KILL_SWITCH",
      "GOAT_IMESSAGE_DAILY_CAP",
      "GOAT_MANAGED_CAPABILITIES_KILL_SWITCH",
      "GOAT_DISABLED_MANAGED_CAPABILITY_ACTIONS",
      "LATITUDE_API_KEY",
      "LATITUDE_PROJECT_SLUG",
      "LATITUDE_SERVICE_NAME",
      "LATITUDE_TELEMETRY_DISABLED",
    ],
  },
  api: {
    label: "Render canonical Chat API",
    required: [
      "API_DATABASE_URL",
      "WORKOS_CLIENT_ID",
      "WORKOS_API_KEY",
      "WORKOS_COOKIE_PASSWORD",
      "WORKOS_COOKIE_DOMAIN",
      "API_BROWSER_ORIGINS",
      "GOAT_AUTHKIT_DOMAIN",
      "GOAT_API_OAUTH_AUDIENCE",
      "VERCEL_AI_GATEWAY_API_KEY",
      "BLOB_READ_WRITE_TOKEN",
      "ELECTRIC_URL",
      "REDIS_URL",
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
      // GitHub App OAuth + webhook ingress (#1203 4a1). The API redirects back
      // to the web origin, so it also needs the canonical app URL.
      "GOAT_NEXT_PUBLIC_APP_URL",
      "GITHUB_INTEGRATION_APP_ID",
      "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
      "GITHUB_INTEGRATION_APP_SLUG",
      "GITHUB_INTEGRATION_APP_CLIENT_ID",
      "GITHUB_INTEGRATION_APP_CLIENT_SECRET",
      "GITHUB_INTEGRATION_STATE_SECRET",
      "GITHUB_INTEGRATION_APP_WEBHOOK_SECRET",
      // Google-family OAuth ingress (#1203 4a2).
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_INTEGRATION_STATE_SECRET",
      // Slack ingestion + Linear ingest OAuth/webhook ingress (#1203 4b1).
      "GOAT_SLACK_CLIENT_ID",
      "GOAT_SLACK_CLIENT_SECRET",
      "GOAT_SLACK_SIGNING_SECRET",
      "GOAT_SLACK_STATE_SECRET",
      "GOAT_LINEAR_CLIENT_ID",
      "GOAT_LINEAR_CLIENT_SECRET",
      "GOAT_LINEAR_WEBHOOK_SECRET",
      "GOAT_LINEAR_STATE_SECRET",
      // #1203 4d1: remote-MCP, X account, and Slack bot OAuth ingress. The
      // Slack bot signing secret stays web-owned for the events webhook but is
      // part of the shared isGoatSlackBotConfigured gate.
      "MCP_OAUTH_STATE_SECRET",
      "GOAT_X_CLIENT_ID",
      "GOAT_X_CLIENT_SECRET",
      "GOAT_X_STATE_SECRET",
      "GOAT_SLACK_BOT_CLIENT_ID",
      "GOAT_SLACK_BOT_CLIENT_SECRET",
      "GOAT_SLACK_BOT_SIGNING_SECRET",
      "GOAT_SLACK_BOT_STATE_SECRET",
    ],
    // Browser profiles are feature-flag gated: the Browserbase credentials are
    // required only when GOAT_BROWSER_PROFILES_ENABLED is "true" in this env.
    conditional: [
      {
        when: "GOAT_BROWSER_PROFILES_ENABLED",
        equals: "true",
        require: ["BROWSERBASE_API_KEY"],
      },
    ],
    optional: [
      // HubSpot OAuth/webhook ingress (#1203 4c) is code-complete but the
      // HubSpot app is unprovisioned in production; Attio and Jamie verify
      // against per-integration credentials and need no env. Promote these to
      // required when the HubSpot app is set up.
      "GOAT_HUBSPOT_CLIENT_ID",
      "GOAT_HUBSPOT_CLIENT_SECRET",
      "GOAT_HUBSPOT_STATE_SECRET",
      "API_DB_POOL_MAX",
      "WORKOS_COOKIE_NAME",
      "GOAT_DEFAULT_CHAT_MODEL",
      "GOAT_BROWSER_PROFILES_ENABLED",
      "GOAT_BROWSER_PROFILES_KILL_SWITCH",
      "BROWSERBASE_API_KEY",
      "BROWSERBASE_PROJECT_ID",
      "ELECTRIC_SOURCE_ID",
      "ELECTRIC_SOURCE_SECRET",
      "ELECTRIC_SECRET",
      "ELECTRIC_TOKEN",
      "BETTER_STACK_ERRORS_DSN",
      "OBSERVABILITY_ENABLED",
      "OBSERVABILITY_ENV",
      "OBSERVABILITY_RELEASE",
      "OBSERVABILITY_LOG_LEVEL",
      "OBSERVABILITY_TIMING",
      "GOAT_OBSERVABILITY_ENABLED",
      "GOAT_OTEL_EXPORTER_OTLP_ENDPOINT",
      "GOAT_OTEL_EXPORTER_OTLP_HEADERS",
      "NEXT_PUBLIC_GOAT_POSTHOG_TOKEN",
      "NEXT_PUBLIC_GOAT_POSTHOG_HOST",
    ],
  },
  runner: {
    label: "Render runner",
    // The runner drives in-process browser profile agent sessions; the same
    // feature gate applies as in the API group.
    conditional: [
      {
        when: "GOAT_BROWSER_PROFILES_ENABLED",
        equals: "true",
        require: ["BROWSERBASE_API_KEY"],
      },
    ],
    required: [
      "DATABASE_URL",
      "RUNNER_INTERNAL_TOKEN",
      "GOAT_NEXT_PUBLIC_APP_URL",
      "RUNNER_STREAM_TOKEN_SECRET",
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
      "RUNNER_ALLOWED_ORIGINS",
      "E2B_API_KEY",
      "VERCEL_AI_GATEWAY_API_KEY",
      "OPENAI_CODEX_API_KEY",
      "GITHUB_INTEGRATION_APP_ID",
      "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
      "GOAT_X_CLIENT_ID",
      "GOAT_X_CLIENT_SECRET",
      "NEXT_PUBLIC_GOAT_POSTHOG_TOKEN",
      "NEXT_PUBLIC_GOAT_POSTHOG_HOST",
      "REDIS_URL",
    ],
    optional: [
      "EXA_API_KEY",
      "APIFY_API_TOKEN",
      "OPENCOMPANY_CODEX_E2B_TEMPLATE",
      "RUNNER_INSTANCE_ID",
      "RUNNER_PREVIEW_BASE_DOMAIN",
      "RUNNER_PREVIEW_PROTOCOL",
      "GOAT_DICTATION_REALTIME_MODEL",
      "GOAT_DICTATION_FINAL_MODEL",
      "OPENAI_API_KEY",
      "BETTER_STACK_ERRORS_DSN",
      "OBSERVABILITY_ENABLED",
      "OBSERVABILITY_ENV",
      "OBSERVABILITY_RELEASE",
      "OBSERVABILITY_LOG_LEVEL",
      "OBSERVABILITY_TIMING",
      "GOAT_OBSERVABILITY_ENABLED",
      "GOAT_OTEL_EXPORTER_OTLP_ENDPOINT",
      "GOAT_OTEL_EXPORTER_OTLP_HEADERS",
      "LINQ_API_TOKEN",
      "LINQ_FROM_NUMBER",
      "LINQ_API_BASE_URL",
      "GOAT_IMESSAGE_PROVIDER",
      "GOAT_IMESSAGE_KILL_SWITCH",
      "GOAT_IMESSAGE_DAILY_CAP",
      "LATITUDE_API_KEY",
      "LATITUDE_PROJECT_SLUG",
      "LATITUDE_SERVICE_NAME",
      "LATITUDE_TELEMETRY_DISABLED",
    ],
  },
  release: {
    label: "GitHub Actions release automation",
    required: [
      "PRODUCTION_DATABASE_URL",
      "VERCEL_TOKEN",
      "VERCEL_ORG_ID",
      "GOAT_VERCEL_PROJECT_ID",
      "MARKETING_VERCEL_PROJECT_ID",
      "RENDER_SERVICE_ID",
      "RENDER_API_SERVICE_ID",
      "RENDER_API_KEY",
      "PRODUCTION_GOAT_URL",
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
  web: process.env.GOAT_VERCEL_PROJECT_ID,
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

if (selected.some((name) => name === "web" || name === "runner")) {
  const latitudeApiKeySet = !isUnset(process.env.LATITUDE_API_KEY);
  const latitudeProjectSet = !isUnset(process.env.LATITUDE_PROJECT_SLUG);
  if (latitudeApiKeySet !== latitudeProjectSet) {
    failed = true;
    console.log(
      "\nLATITUDE_API_KEY and LATITUDE_PROJECT_SLUG must either both be set or both be unset.",
    );
  }
}

const cookiePassword = process.env.WORKOS_COOKIE_PASSWORD;
if (!isUnset(cookiePassword) && cookiePassword.length < 32) {
  failed = true;
  console.log("\nWORKOS_COOKIE_PASSWORD must be at least 32 characters.");
}

const githubIntegrationStateSecret = process.env.GITHUB_INTEGRATION_STATE_SECRET;
if (!isUnset(githubIntegrationStateSecret) && githubIntegrationStateSecret.length < 32) {
  failed = true;
  console.log("\nGITHUB_INTEGRATION_STATE_SECRET must be at least 32 characters.");
}

const webRedirectUri = process.env.GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI;
if (
  webRedirectUri &&
  !webRedirectUri.startsWith("https://") &&
  !webRedirectUri.includes("localhost")
) {
  failed = true;
  console.log(
    "\nGOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI should be https:// outside local development.",
  );
}

if (selected.includes("web") && !isUnset(process.env.NEXT_PUBLIC_GOAT_API_ORIGIN)) {
  const configuredApiOrigin = httpOrigin(process.env.NEXT_PUBLIC_GOAT_API_ORIGIN);
  const expectedApiOrigin = httpOrigin(process.env.PRODUCTION_API_URL);
  if (!configuredApiOrigin || (expectedApiOrigin && configuredApiOrigin !== expectedApiOrigin)) {
    failed = true;
    console.log("\nNEXT_PUBLIC_GOAT_API_ORIGIN must match the production API HTTPS origin.");
  }
}

if (selected.includes("api") && !isUnset(process.env.API_BROWSER_ORIGINS)) {
  const browserOrigins = process.env.API_BROWSER_ORIGINS.split(",").map((value) =>
    httpOrigin(value),
  );
  const expectedWebOrigin = httpOrigin(process.env.PRODUCTION_GOAT_URL);
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
  const webHostname = hostname(process.env.PRODUCTION_GOAT_URL);
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

  return requested.length > 0 ? requested : ["web", "api", "runner"];
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
