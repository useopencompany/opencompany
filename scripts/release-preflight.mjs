#!/usr/bin/env node

// Called by: release workflow checks and root `bun run release:preflight`.
// Purpose: validates required release, web, runner, and smoke-check environment variables.

import "./load-env.mjs";

const groups = {
  web: {
    label: "Vercel web app",
    required: [
      "DATABASE_URL",
      "WORKOS_CLIENT_ID",
      "WORKOS_API_KEY",
      "WORKOS_COOKIE_PASSWORD",
      "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
      "OPENCOMPANY_GITHUB_ORG",
      "GITHUB_APP_ID",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_INTEGRATION_APP_ID",
      "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
      "GITHUB_INTEGRATION_APP_SLUG",
      "GITHUB_INTEGRATION_APP_CLIENT_ID",
      "GITHUB_INTEGRATION_APP_CLIENT_SECRET",
      "GITHUB_INTEGRATION_STATE_SECRET",
      "INNGEST_EVENT_KEY",
      "INNGEST_SIGNING_KEY",
      "RUNNER_PUBLIC_URL",
      "RUNNER_INTERNAL_TOKEN",
      "RUNNER_STREAM_TOKEN_SECRET",
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
    ],
    optional: [
      "RUNNER_INTERNAL_URL",
      "NEXT_PUBLIC_POSTHOG_TOKEN",
      "NEXT_PUBLIC_POSTHOG_HOST",
      "BETTER_STACK_ERRORS_DSN",
      "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN",
      "LINEAR_API_KEY",
      "LINEAR_TEAM_ID",
    ],
  },
  goat: {
    label: "Vercel Goat app",
    required: [
      "DATABASE_URL",
      "WORKOS_CLIENT_ID",
      "WORKOS_API_KEY",
      "WORKOS_COOKIE_PASSWORD",
      "GOAT_NEXT_PUBLIC_APP_URL",
      "GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI",
      "GOAT_AUTHKIT_DOMAIN",
      "GOAT_MACOS_OAUTH_CLIENT_ID",
      "VERCEL_AI_GATEWAY_API_KEY",
      "RUNNER_PUBLIC_URL",
      "RUNNER_INTERNAL_TOKEN",
      "ELECTRIC_URL",
      "MONID_API_KEY",
    ],
    optional: [
      "RUNNER_INTERNAL_URL",
      "EXA_API_KEY",
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
      "MCP_OAUTH_STATE_SECRET",
      "GITHUB_INTEGRATION_APP_ID",
      "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
      "GITHUB_INTEGRATION_APP_SLUG",
      "GITHUB_INTEGRATION_APP_CLIENT_ID",
      "GITHUB_INTEGRATION_APP_CLIENT_SECRET",
      "GITHUB_INTEGRATION_STATE_SECRET",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_CALLBACK_URL",
      "GOOGLE_INTEGRATION_STATE_SECRET",
      "ELECTRIC_SOURCE_ID",
      "ELECTRIC_SOURCE_SECRET",
      "ELECTRIC_SECRET",
      "ELECTRIC_TOKEN",
      "GOAT_OBSERVABILITY_ENABLED",
      "GOAT_OTEL_EXPORTER_OTLP_ENDPOINT",
      "GOAT_OTEL_EXPORTER_OTLP_HEADERS",
      "GOAT_CHAT_ACTIONS_KILL_SWITCH",
      "GOAT_MANAGED_CAPABILITIES_KILL_SWITCH",
      "GOAT_DISABLED_MANAGED_CAPABILITY_ACTIONS",
      "LATITUDE_API_KEY",
      "LATITUDE_PROJECT_SLUG",
      "LATITUDE_SERVICE_NAME",
      "LATITUDE_TELEMETRY_DISABLED",
    ],
  },
  runner: {
    label: "Render runner",
    required: [
      "DATABASE_URL",
      "RUNNER_INTERNAL_TOKEN",
      "RUNNER_STREAM_TOKEN_SECRET",
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
      "RUNNER_ALLOWED_ORIGINS",
      "E2B_API_KEY",
      "VERCEL_AI_GATEWAY_API_KEY",
      "GITHUB_APP_ID",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_INTEGRATION_APP_ID",
      "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
    ],
    optional: [
      "EXA_API_KEY",
      "APIFY_API_TOKEN",
      "X_API_BEARER_TOKEN",
      "SUPADATA_API_KEY",
      "OPENCOMPANY_E2B_TEMPLATE",
      "AMP_API_KEY",
      "OPENCOMPANY_AMP_E2B_TEMPLATE",
      "RUNNER_E2B_IDLE_TIMEOUT_MS",
      "RUNNER_INSTANCE_ID",
      "BETTER_STACK_ERRORS_DSN",
      "OBSERVABILITY_ENABLED",
      "OBSERVABILITY_ENV",
      "OBSERVABILITY_RELEASE",
      "OBSERVABILITY_LOG_LEVEL",
      "OBSERVABILITY_TIMING",
      "GOAT_OBSERVABILITY_ENABLED",
      "GOAT_OTEL_EXPORTER_OTLP_ENDPOINT",
      "GOAT_OTEL_EXPORTER_OTLP_HEADERS",
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
      "VERCEL_PROJECT_ID",
      "GOAT_VERCEL_PROJECT_ID",
      "MARKETING_VERCEL_PROJECT_ID",
      "RENDER_SERVICE_ID",
      "RENDER_API_KEY",
      "PRODUCTION_WEB_URL",
      "PRODUCTION_GOAT_URL",
      "RUNNER_PUBLIC_URL",
    ],
    optional: [],
  },
};

const selected = selectGroups();
let failed = false;

for (const name of selected) {
  const group = groups[name];
  const missing = group.required.filter((key) => isUnset(process.env[key]));
  const placeholders = group.required.filter((key) => isPlaceholder(process.env[key]));
  const optionalMissing = group.optional.filter((key) => isUnset(process.env[key]));

  console.log(`\n${group.label}`);
  console.log(`  required: ${group.required.length - missing.length}/${group.required.length} set`);

  if (missing.length > 0) {
    failed = true;
    console.log(`  missing: ${missing.join(", ")}`);
  }

  if (placeholders.length > 0) {
    failed = true;
    console.log(`  placeholders: ${placeholders.join(", ")}`);
  }

  if (optionalMissing.length > 0) {
    console.log(`  optional unset: ${optionalMissing.join(", ")}`);
  }
}

if (selected.some((name) => name === "goat" || name === "runner")) {
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

const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI;
if (redirectUri && !redirectUri.startsWith("https://") && !redirectUri.includes("localhost")) {
  failed = true;
  console.log("\nNEXT_PUBLIC_WORKOS_REDIRECT_URI should be https:// outside local development.");
}

const goatRedirectUri = process.env.GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI;
if (
  goatRedirectUri &&
  !goatRedirectUri.startsWith("https://") &&
  !goatRedirectUri.includes("localhost")
) {
  failed = true;
  console.log(
    "\nGOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI should be https:// outside local development.",
  );
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

  return requested.length > 0 ? requested : ["web", "runner"];
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
