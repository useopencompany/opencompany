#!/usr/bin/env node

// Called by: .github/workflows/release-production.yml and root `bun run release:render`.
// Purpose: triggers and waits for a Render service deploy for the release commit.

import { appendFileSync } from "node:fs";

import {
  deployCommitMatches,
  isFailedDeployStatus,
  selectNewDeployForRelease,
} from "./lib/render-release.mjs";

const renderApiUrl = process.env.RENDER_API_URL ?? "https://api.render.com/v1";
const serviceId = requiredEnv("RENDER_SERVICE_ID");
const apiKey = requiredEnv("RENDER_API_KEY");
const timeoutMs = positiveNumberEnv("RENDER_DEPLOY_TIMEOUT_MS", 900000);
const pollMs = positiveNumberEnv("RENDER_DEPLOY_POLL_MS", 10000);
const staleMs = positiveNumberEnv("RENDER_DEPLOY_STALE_MS", 600000);
const args = parseArgs(process.argv.slice(2));

// Render runs one deploy at a time per service, so a hung build blocks every
// deploy queued behind it. Releases always target the latest main commit, so
// any deploy still in flight after `staleMs` is hung or superseded.
const IN_FLIGHT_STATUSES = new Set([
  "created",
  "queued",
  "build_in_progress",
  "pre_deploy_in_progress",
  "update_in_progress",
]);

await main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  if (args.mode === "cancel") {
    await cancelDeploy(args.deployId);
    return;
  }

  const releaseSha = requiredEnv("RELEASE_SHA");

  if (args.mode === "wait") {
    await waitForDeploy(args.deployId, releaseSha);
    return;
  }

  await cancelStaleInFlightDeploys();

  const deploy = await triggerDeploy(releaseSha);
  console.log(`Triggered Render deploy ${deploy.id} for ${shortSha(releaseSha)}.`);
  writeGithubOutput("deploy_id", deploy.id);

  if (args.mode === "trigger-only") {
    return;
  }

  await waitForDeploy(deploy.id, releaseSha);
}

async function triggerDeploy(releaseSha) {
  const existingDeployIds = new Set((await listDeploys()).map((deploy) => deploy.id));
  const response = await renderRequest(
    `/services/${serviceId}/deploys`,
    {
      method: "POST",
      body: JSON.stringify({ commitId: releaseSha }),
    },
    {
      allowEmpty: true,
    },
  );

  if (!response) {
    return waitForTriggeredDeploy(releaseSha, existingDeployIds);
  }

  assertDeployCommit(response, releaseSha);
  return response;
}

async function waitForTriggeredDeploy(releaseSha, existingDeployIds) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const deploy = await findNewDeployForRelease(releaseSha, existingDeployIds);
    if (deploy) {
      assertDeployCommit(deploy, releaseSha);
      return deploy;
    }
    await sleep(2000);
  }

  throw new Error(
    `Render accepted the deploy request but did not expose its API-triggered deploy for ${releaseSha}.`,
  );
}

async function cancelStaleInFlightDeploys() {
  const response = await renderRequest(`/services/${serviceId}/deploys?limit=10`);
  const deploys = Array.isArray(response) ? response.map((item) => item.deploy ?? item) : [];
  const cutoff = Date.now() - staleMs;

  for (const deploy of deploys) {
    if (!IN_FLIGHT_STATUSES.has(deploy.status)) continue;

    const createdAt = Date.parse(deploy.createdAt ?? "");
    if (!Number.isFinite(createdAt) || createdAt > cutoff) continue;

    console.warn(
      `Render deploy ${deploy.id} has been ${deploy.status} since ${deploy.createdAt}; cancelling it so it cannot block this release.`,
    );
    await cancelDeploy(deploy.id);
  }
}

async function listDeploys() {
  const response = await renderRequest(`/services/${serviceId}/deploys`);
  return Array.isArray(response) ? response.map((item) => item.deploy ?? item) : [];
}

async function findNewDeployForRelease(releaseSha, existingDeployIds) {
  return selectNewDeployForRelease(await listDeploys(), releaseSha, existingDeployIds);
}

async function waitForDeploy(deployId, releaseSha) {
  const deadline = Date.now() + timeoutMs;
  let lastDeploy;

  while (Date.now() < deadline) {
    const deploy = await renderRequest(`/services/${serviceId}/deploys/${deployId}`);
    lastDeploy = deploy;
    assertDeployCommit(deploy, releaseSha);

    const status = deploy.status ?? "unknown";
    console.log(`Render deploy ${deployId} status: ${status}`);

    if (status === "live") {
      console.log(`Render deploy ${deployId} is live.`);
      return;
    }

    if (isFailedDeployStatus(status)) {
      throw new Error(`Render deploy ${deployId} failed with status ${status}.`);
    }

    await sleep(pollMs);
  }

  if (IN_FLIGHT_STATUSES.has(lastDeploy?.status)) {
    console.warn(`Cancelling Render deploy ${deployId} so it does not block the next release.`);
    await cancelDeploy(deployId);
  }

  throw new Error(
    `Render deploy ${deployId} did not finish within ${Math.round(
      timeoutMs / 1000,
    )}s. Last status: ${lastDeploy?.status ?? "unknown"}.`,
  );
}

async function cancelDeploy(deployId) {
  try {
    await renderRequest(
      `/services/${serviceId}/deploys/${deployId}/cancel`,
      {
        method: "POST",
      },
      {
        allowEmpty: true,
      },
    );
    console.log(`Requested cancellation for Render deploy ${deployId}.`);
  } catch (error) {
    console.warn(`Could not cancel Render deploy ${deployId}: ${error.message}`);
  }
}

async function renderRequest(path, init = {}, options = {}) {
  let response;
  try {
    response = await fetch(`${renderApiUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    throw new Error(`Render API request failed: ${error.cause?.message ?? error.message}`);
  }
  const body = await response.text();
  const payload = parseJson(body);

  if (!response.ok) {
    const detail = payload ? JSON.stringify(payload) : body.slice(0, 300);
    throw new Error(`Render API ${response.status} ${response.statusText}: ${detail}`);
  }

  if (!payload && options.allowEmpty) {
    return null;
  }

  if (!payload || typeof payload !== "object") {
    throw new Error(`Render API returned a non-JSON response: ${body.slice(0, 300)}`);
  }

  return payload;
}

function parseArgs(argv) {
  if (argv.length === 0) return { mode: "deploy" };

  const [command, deployId, ...rest] = argv;
  if (rest.length > 0) {
    usage(`Unexpected argument: ${rest[0]}`);
  }

  if (command === "--trigger-only") {
    if (deployId) usage("--trigger-only does not accept a deploy ID.");
    return { mode: "trigger-only" };
  }

  if (command === "--wait") {
    if (!deployId) usage("--wait requires a deploy ID.");
    return { mode: "wait", deployId };
  }

  if (command === "--cancel") {
    if (!deployId) usage("--cancel requires a deploy ID.");
    return { mode: "cancel", deployId };
  }

  usage(`Unknown argument: ${command}`);
}

function usage(message) {
  console.error(message);
  console.error(
    "Usage: render-release.mjs [--trigger-only | --wait <deploy_id> | --cancel <deploy_id>]",
  );
  process.exit(1);
}

function writeGithubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath || !value) return;

  appendFileSync(outputPath, `${name}=${value}\n`);
}

function assertDeployCommit(deploy, expectedSha) {
  const commitId = deploy.commit?.id;
  if (typeof commitId === "string" && !deployCommitMatches(deploy, expectedSha)) {
    throw new Error(
      `Render deploy ${deploy.id ?? "(unknown)"} is for ${commitId}, expected ${expectedSha}.`,
    );
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required.`);
    process.exit(1);
  }
  return value;
}

function positiveNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`${name} must be a positive number.`);
    process.exit(1);
  }
  return value;
}

function shortSha(value) {
  return value.slice(0, 7);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
