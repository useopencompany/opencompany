#!/usr/bin/env node

// Provision (or idempotently update) a full per-PR preview stack — issue #351.
// Single owner: GitHub Actions calls this; it creates or reuses the Neon branch from the
// sanitized seed, migrates it, then creates/updates the per-PR Render services (Durable Streams →
// Electric → runner) wired to the branch, and emits a manifest + GITHUB_OUTPUT the
// workflow uses to deploy the Vercel web app and record the GitHub Deployment.
//
// The Vercel web deploy itself stays in the workflow (it needs the prebuilt artifacts).
//
// Run `--dry-run` to print every external action + payload WITHOUT calling any API. Use
// this to validate the Render payloads against your account before the first real run.
//
// Usage: node scripts/preview-provision.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import {
  buildManifest,
  electricServiceEnv,
  previewNames,
  runnerServiceEnv,
  webDeployEnv,
} from "./lib/preview-config.mjs";
import { createNeonClient } from "./lib/preview-neon.mjs";
import {
  buildElectricServiceSpec,
  buildRunnerServiceSpec,
  buildStreamsServiceSpec,
  createRenderClient,
  toRenderEnvVars,
} from "./lib/preview-render.mjs";

const dryRun = process.argv.includes("--dry-run") || isTrue(process.env.PREVIEW_DRY_RUN);

const pr = requireEnv("PREVIEW_PR_NUMBER");
const sha = requireEnv("PREVIEW_SHA");
const baseDomain = requireEnv("PREVIEW_BASE_DOMAIN");
const reset = isTrue(process.env.PREVIEW_RESET);

const neonApiKey = requireEnv("NEON_API_KEY");
const neonProjectId = requireEnv("NEON_PROJECT_ID");
const seedBranch = safeSeedBranch(process.env.PREVIEW_SEED_BRANCH);
const ttlHours = nonNegativeNumberEnv("NEON_BRANCH_TTL_HOURS", "24");

const renderApiKey = requireEnv("RENDER_API_KEY");
// Optional: auto-resolved from the API when the key has a single workspace owner.
let renderOwnerId = process.env.RENDER_OWNER_ID?.trim();
const repoUrl =
  process.env.PREVIEW_REPO_URL?.trim() ||
  (process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : "");
const prBranch = requireEnv("PREVIEW_PR_BRANCH");
const renderRegion = process.env.RENDER_REGION?.trim() || "frankfurt";
const renderPlan = process.env.RENDER_PLAN?.trim() || "starter";
const previewRenderLogStream = previewRenderLogStreamConfig(process.env);
const electricImage = process.env.ELECTRIC_IMAGE?.trim() || "docker.io/electricsql/electric:latest";
const electricStorageDir = process.env.ELECTRIC_STORAGE_DIR?.trim();
const googleOAuthCallbackUrl = process.env.GOOGLE_OAUTH_CALLBACK_URL?.trim();

const requiredRunnerRuntimeEnv = requiredEnvMap([
  "E2B_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
  "OPENAI_CODEX_API_KEY",
  "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_INTEGRATION_APP_ID",
  "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
]);
const optionalRunnerRuntimeEnv = optionalEnvMap([
  "EXA_API_KEY",
  "X_API_BEARER_TOKEN",
  "APIFY_API_TOKEN",
  "SUPADATA_API_KEY",
  "AMP_API_KEY",
  "OPENCOMPANY_E2B_TEMPLATE",
  "OPENCOMPANY_AMP_E2B_TEMPLATE",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "SLACK_MCP_CLIENT_ID",
  "SLACK_MCP_CLIENT_SECRET",
  "BETTER_STACK_ERRORS_DSN",
  "OBSERVABILITY_ENABLED",
  "OBSERVABILITY_LOG_LEVEL",
  "OBSERVABILITY_TIMING",
  "BRAINTRUST_ENABLED",
  "BRAINTRUST_API_KEY",
  "BRAINTRUST_PROJECT_ID",
  "BRAINTRUST_PROJECT_NAME",
  "LATITUDE_API_KEY",
  "LATITUDE_PROJECT_SLUG",
  "LATITUDE_SERVICE_NAME",
  "LATITUDE_TELEMETRY_DISABLED",
]);

// Per-PR shared secrets: minted here, injected into both producer and consumer sides.
const runnerInternalToken =
  process.env.PREVIEW_RUNNER_INTERNAL_TOKEN?.trim() || `pv-${randomUUID()}`;
const runnerStreamTokenSecret =
  process.env.PREVIEW_RUNNER_STREAM_TOKEN_SECRET?.trim() || `pv-${randomUUID()}`;
const electricSecret = process.env.ELECTRIC_SECRET?.trim() || `pv-${randomUUID()}`;
const streamsToken = process.env.PREVIEW_DURABLE_STREAMS_TOKEN?.trim() || `pv-${randomUUID()}`;

// Register the per-PR secrets as GitHub Actions masks the moment they exist, so they're
// redacted everywhere downstream (step logs, the web_env job output) — GITHUB_OUTPUT values
// are NOT masked by default. DB URLs are masked later, once the Neon branch is resolved.
maskSecrets([
  runnerInternalToken,
  runnerStreamTokenSecret,
  electricSecret,
  streamsToken,
  previewRenderLogStream?.token,
]);

const names = previewNames(pr, { baseDomain });

await main().catch((error) => {
  console.error(`\nPreview provision failed: ${error.message}`);
  process.exit(1);
});

async function main() {
  log(
    `Provisioning preview stack for PR #${pr} (sha ${sha.slice(0, 7)})${dryRun ? " [DRY RUN]" : ""}`,
  );

  // 1) Neon branch from the sanitized seed. Existing branches are reused unless an
  // operator explicitly sets PREVIEW_RESET for a clean reprovision.
  const neon = createNeonClient({
    apiKey: neonApiKey,
    projectId: neonProjectId,
    parentBranch: seedBranch,
  });
  let branchId = "br-DRYRUN";
  let pooledUrl = "postgresql://DRYRUN-pooler.neon.tech/neondb";
  let directUrl = "postgresql://DRYRUN.neon.tech/neondb";
  if (dryRun) {
    log(
      `would ensure Neon branch ${names.neonBranch} from ${seedBranch} (reset=${reset}), ttl=${ttlHours}h`,
    );
  } else {
    neon.ensureBranch(names.neonBranch, { reset });
    if (ttlHours > 0) neon.setExpiration(names.neonBranch, expiresAt(ttlHours));
    const conn = neon.resolveConnection(names.neonBranch);
    branchId = conn.branchId;
    pooledUrl = conn.pooledUrl;
    directUrl = conn.directUrl;
    // Connection strings embed credentials — mask before they can reach any log/output.
    maskSecrets([pooledUrl, directUrl]);
    log(`Neon branch ${names.neonBranch} ready (${branchId}).`);
  }

  // 2) Migrate the branch so its schema matches this SHA before anything connects.
  if (isTrue(process.env.PREVIEW_SKIP_MIGRATE)) {
    log("Skipping migrate (PREVIEW_SKIP_MIGRATE).");
  } else if (dryRun) {
    log("would run `bun run db:migrate` against the branch direct endpoint");
  } else {
    log("Migrating branch...");
    execFileSync("bun", ["run", "db:migrate"], {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: directUrl },
    });
  }

  // 3) Render services. Order matters: streams + electric URLs feed the runner + web.
  const render = createRenderClient({ apiKey: renderApiKey });
  if (!renderOwnerId && !dryRun) {
    renderOwnerId = await render.resolveOwnerId();
    log(`Resolved Render owner id: ${renderOwnerId}`);
  }
  renderOwnerId = renderOwnerId || "own-DRYRUN";

  const streamsEnv = compact({
    DURABLE_STREAMS_DEV_HOST: "0.0.0.0",
    DURABLE_STREAMS_TOKEN: streamsToken,
  });
  const streamsPromise = ensureService(render, {
    name: names.streamsService,
    env: streamsEnv,
    buildSpec: (env) =>
      buildStreamsServiceSpec({
        name: names.streamsService,
        ownerId: renderOwnerId,
        repo: repoUrl,
        branch: prBranch,
        plan: renderPlan,
        region: renderRegion,
        env,
      }),
  });

  const electricEnv = electricServiceEnv({
    directDatabaseUrl: directUrl,
    electricSecret,
    storageDir: electricStorageDir,
  });
  const electricPromise = ensureService(render, {
    name: names.electricService,
    env: electricEnv,
    buildSpec: (env) =>
      buildElectricServiceSpec({
        name: names.electricService,
        ownerId: renderOwnerId,
        image: electricImage,
        plan: renderPlan,
        region: renderRegion,
        env,
      }),
  });

  // Streams and Electric are independent. Start them together, then start the runner
  // as soon as Streams has a URL; Electric can keep deploying in parallel.
  const streams = await streamsPromise;
  const runnerEnv = runnerServiceEnv({
    pr,
    directDatabaseUrl: directUrl,
    neonBranchId: branchId,
    neonProjectId,
    neonApiKey,
    runnerInternalToken,
    runnerStreamTokenSecret,
    runnerRuntimeEnv: { ...requiredRunnerRuntimeEnv, ...optionalRunnerRuntimeEnv },
    streamsUrl: streams.url,
    streamsToken,
    allowedOrigins: names.aliasUrl,
  });
  const runnerPromise = ensureService(render, {
    name: names.runnerService,
    env: runnerEnv,
    afterServiceId: (serviceId) =>
      configureRunnerLogStream(render, serviceId, {
        serviceName: names.runnerService,
        logStream: previewRenderLogStream,
      }),
    buildSpec: (env) =>
      buildRunnerServiceSpec({
        name: names.runnerService,
        ownerId: renderOwnerId,
        repo: repoUrl,
        branch: prBranch,
        plan: renderPlan,
        region: renderRegion,
        env,
      }),
  });
  const [electric, runner] = await Promise.all([electricPromise, runnerPromise]);

  // 4) Manifest + outputs for the workflow (Vercel deploy + GitHub Deployment record).
  const manifest = buildManifest({
    pr,
    sha,
    createdAt: nowIso(),
    neonBranchId: branchId,
    neonBranchName: names.neonBranch,
    runnerServiceId: runner.id,
    runnerUrl: runner.url,
    electricServiceId: electric.id,
    electricUrl: electric.url,
    streamsServiceId: streams.id,
    streamsUrl: streams.url,
    alias: names.alias,
    ttlHours,
  });

  const webEnv = webDeployEnv({
    pr,
    sha,
    appUrl: names.aliasUrl,
    databaseUrl: pooledUrl,
    appUrl: names.aliasUrl,
    runnerUrl: runner.url,
    runnerInternalToken,
    electricUrl: electric.url,
    electricSecret,
    streamsUrl: streams.url,
    streamsToken,
    redirectUri: names.redirectUri,
    googleOAuthCallbackUrl,
  });

  emitOutputs({ manifest, webEnv });
  log("Preview provision complete.");
}

// Create the service if missing, else replace its env vars + trigger a fresh deploy.
// `env` is the single source of truth: the create payload and the update both use it.
async function ensureService(render, { name, buildSpec, env, afterServiceId }) {
  if (dryRun) {
    log(`would ensure Render service ${name}`);
    // Redact env var values: a dry run loaded with real secrets must not dump them to stdout.
    // Keys stay visible so the payload shape can still be validated.
    console.log(JSON.stringify(redactSpecEnv(buildSpec(env)), null, 2));
    if (afterServiceId) await afterServiceId(`srv-DRYRUN-${name}`);
    return { id: `srv-DRYRUN-${name}`, url: `https://${name}.onrender.com` };
  }
  const existing = await render.findServiceByName(name);
  if (existing) {
    log(`Updating Render service ${name} (${existing.id}).`);
    if (afterServiceId) await afterServiceId(existing.id);
    await render.replaceEnvVars(existing.id, toRenderEnvVars(env));
    const deploy = await render.triggerDeploy(existing.id, { clearCache: false });
    try {
      await render.waitForDeploy(existing.id, deploy.id);
    } catch (error) {
      log(
        `Render update for ${name} (${existing.id}) failed: ${error.message}. Recreating the preview service.`,
      );
      await render.deleteService(existing.id);
      await waitForServiceDeletion(render, name);
      return createService(render, name, buildSpec(env), { afterServiceId });
    }
    const svc = await render.getService(existing.id);
    return { id: existing.id, url: serviceUrl(svc, name) };
  }
  return createService(render, name, buildSpec(env), { afterServiceId });
}

async function createService(render, name, spec, { afterServiceId } = {}) {
  log(`Creating Render service ${name}.`);
  const { service, deployId } = await render.createService(spec);
  if (afterServiceId) await afterServiceId(service.id);
  if (deployId) await render.waitForDeploy(service.id, deployId);
  const svc = await render.getService(service.id);
  return { id: service.id, url: serviceUrl(svc, name) };
}

async function configureRunnerLogStream(render, serviceId, { serviceName, logStream }) {
  if (!logStream) {
    log(
      `Skipping runner log stream override for ${serviceName}; PREVIEW_RENDER_LOG_ENDPOINT is unset.`,
    );
    return;
  }
  if (dryRun) {
    log(`would configure runner log stream override for ${serviceName} (${serviceId}).`);
    return;
  }
  await render.updateResourceLogStream(serviceId, logStream);
  log(`Configured runner log stream override for ${serviceName} (${serviceId}).`);
}

function serviceUrl(service, name) {
  return service?.serviceDetails?.url ?? service?.url ?? `https://${name}.onrender.com`;
}

async function waitForServiceDeletion(render, name, { attempts = 12, delayMs = 5000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const existing = await render.findServiceByName(name);
    if (!existing) return;
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for Render service ${name} to delete before recreation.`);
}

function emitOutputs({ manifest, webEnv }) {
  const manifestJson = JSON.stringify(manifest);
  const manifestPath = process.env.PREVIEW_MANIFEST_PATH?.trim();
  if (manifestPath) writeFileSync(manifestPath, `${manifestJson}\n`);

  const webEnvJson = JSON.stringify(webEnv);
  const webEnvPath = process.env.PREVIEW_WEB_ENV_PATH?.trim();
  if (webEnvPath) writeFileSync(webEnvPath, `${webEnvJson}\n`);

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `manifest=${manifestJson}\n`);
    appendFileSync(out, `web_env=${webEnvJson}\n`);
    appendFileSync(out, `runner_url=${manifest.runnerUrl ?? ""}\n`);
    appendFileSync(out, `electric_url=${manifest.electricUrl ?? ""}\n`);
    appendFileSync(out, `alias=${manifest.alias ?? ""}\n`);
    appendFileSync(out, `neon_branch_id=${manifest.neonBranchId ?? ""}\n`);
  }

  log(`Manifest: ${manifestJson}`);
}

function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function previewRenderLogStreamConfig(env) {
  const endpoint = env.PREVIEW_RENDER_LOG_ENDPOINT?.trim();
  const token = env.PREVIEW_RENDER_LOG_TOKEN?.trim();
  if (!endpoint && !token) return null;
  if (!endpoint || !token) {
    console.error(
      "PREVIEW_RENDER_LOG_ENDPOINT and PREVIEW_RENDER_LOG_TOKEN must be set together, or both omitted.",
    );
    process.exit(1);
  }
  return { endpoint, token, setting: "send" };
}
// Emit GitHub Actions mask commands so the given secret values are redacted in all job
// logs (and any step that echoes an output carrying them). No-op outside Actions. Skip
// short/placeholder values — masking a 1-2 char string would redact unrelated log text.
function maskSecrets(values) {
  if (!process.env.GITHUB_ACTIONS) return;
  for (const value of values) {
    const v = typeof value === "string" ? value.trim() : "";
    if (v.length >= 8) console.log(`::add-mask::${v}`);
  }
}
// Return a copy of a Render service spec with every env var value replaced by a redaction
// marker, preserving keys. Used for dry-run logging only.
function redactSpecEnv(spec) {
  if (!spec || !Array.isArray(spec.envVars)) return spec;
  return {
    ...spec,
    envVars: spec.envVars.map((entry) => ({ key: entry.key, value: "***redacted***" })),
  };
}
function expiresAt(hours) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function nowIso() {
  return new Date().toISOString();
}
function log(message) {
  console.log(`[preview-provision] ${message}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function isTrue(value) {
  const raw = value?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}
function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required.`);
    process.exit(1);
  }
  return value;
}
function requiredEnvMap(names) {
  const env = {};
  const missing = [];
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      env[name] = value;
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    console.error(
      `Missing required preview runner runtime env vars: ${missing.join(", ")}. Fetch the runner runtime secret path before provisioning previews.`,
    );
    process.exit(1);
  }
  return env;
}
function optionalEnvMap(names) {
  const env = {};
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) env[name] = value;
  }
  return env;
}
// Fail fast on a malformed TTL: Number("abc") is NaN, which would silently skip
// expiration (ttlHours > 0 is false) and write an invalid TTL into the manifest.
function nonNegativeNumberEnv(name, fallback) {
  const raw = process.env[name]?.trim() || fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} must be a non-negative number; got "${raw}".`);
    process.exit(1);
  }
  return value;
}
function safeSeedBranch(value) {
  const branch = value?.trim() || "preview-seed";
  if (!/^preview-seed(?:[-/_a-z0-9.]+)?$/i.test(branch)) {
    console.error(
      `Unsafe PREVIEW_SEED_BRANCH "${branch}". Use a sanitized preview seed branch named preview-seed or preview-seed-*; never fork previews from production.`,
    );
    process.exit(1);
  }
  return branch;
}
