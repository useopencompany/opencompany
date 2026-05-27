#!/usr/bin/env node

// Called by: .github/workflows/release-production.yml and root `bun run release:render`.
// Purpose: triggers and waits for the Render runner deploy for the release commit.

const renderApiUrl = process.env.RENDER_API_URL ?? "https://api.render.com/v1";
const serviceId = requiredEnv("RENDER_SERVICE_ID");
const apiKey = requiredEnv("RENDER_API_KEY");
const releaseSha = requiredEnv("RELEASE_SHA");
const timeoutMs = positiveNumberEnv("RENDER_DEPLOY_TIMEOUT_MS", 900000);
const pollMs = positiveNumberEnv("RENDER_DEPLOY_POLL_MS", 10000);

await main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const deploy = await triggerDeploy();
  console.log(`Triggered Render deploy ${deploy.id} for ${shortSha(releaseSha)}.`);

  await waitForDeploy(deploy.id);
}

async function triggerDeploy() {
  const response = await renderRequest(`/services/${serviceId}/deploys`, {
    method: "POST",
    body: JSON.stringify({ commitId: releaseSha }),
  });

  assertDeployCommit(response, releaseSha);
  return response;
}

async function waitForDeploy(deployId) {
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

    if (isFailedStatus(status)) {
      throw new Error(`Render deploy ${deployId} failed with status ${status}.`);
    }

    await sleep(pollMs);
  }

  throw new Error(
    `Render deploy ${deployId} did not finish within ${Math.round(
      timeoutMs / 1000,
    )}s. Last status: ${lastDeploy?.status ?? "unknown"}.`,
  );
}

async function renderRequest(path, init = {}) {
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

  if (!payload || typeof payload !== "object") {
    throw new Error(`Render API returned a non-JSON response: ${body.slice(0, 300)}`);
  }

  return payload;
}

function assertDeployCommit(deploy, expectedSha) {
  const commitId = deploy.commit?.id;
  if (
    typeof commitId === "string" &&
    !expectedSha.startsWith(commitId) &&
    !commitId.startsWith(expectedSha)
  ) {
    throw new Error(
      `Render deploy ${deploy.id ?? "(unknown)"} is for ${commitId}, expected ${expectedSha}.`,
    );
  }
}

function isFailedStatus(status) {
  return (
    status === "build_failed" ||
    status === "update_failed" ||
    status === "canceled" ||
    status === "pre_deploy_failed"
  );
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
