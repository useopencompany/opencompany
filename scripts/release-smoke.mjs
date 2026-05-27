#!/usr/bin/env node

// Called by: .github/workflows/release-production.yml and root `bun run release:smoke`.
// Purpose: polls production web and runner health checks after deployment.

const webUrl = normalizeBaseUrl(process.env.PRODUCTION_WEB_URL || process.env.WEB_URL);
const runnerUrl = normalizeBaseUrl(process.env.RUNNER_PUBLIC_URL);
const expectedRelease = process.env.EXPECTED_RELEASE;
const attempts = Number(process.env.SMOKE_ATTEMPTS ?? "30");
const webAttempts = Number(process.env.SMOKE_WEB_ATTEMPTS ?? attempts);
const runnerAttempts = Number(process.env.SMOKE_RUNNER_ATTEMPTS ?? attempts);
const delayMs = Number(process.env.SMOKE_DELAY_MS ?? "10000");
const checkWeb = booleanEnv("SMOKE_WEB", true);
const checkRunner = booleanEnv("SMOKE_RUNNER", true);

if (checkWeb && !webUrl) {
  console.error("PRODUCTION_WEB_URL or WEB_URL is required.");
  process.exit(1);
}

if (checkRunner && !runnerUrl) {
  console.error("RUNNER_PUBLIC_URL is required.");
  process.exit(1);
}

if (checkWeb) {
  await checkUntilReady("web", `${webUrl}/api/healthz`, webAttempts, delayMs);
}

if (checkRunner) {
  await checkUntilReady("runner", `${runnerUrl}/healthz`, runnerAttempts, delayMs);
}

console.log("Release smoke checks passed.");

async function checkUntilReady(name, url, maxAttempts, waitMs) {
  let lastError;

  console.log(`${name} health check target: ${url}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`${response.status} ${body.slice(0, 200)}`);
      }

      const payload = parseJson(body);
      if (payload?.ok !== true) {
        throw new Error(`unexpected payload: ${body.slice(0, 200)}`);
      }

      if (expectedRelease && !matchesExpectedRelease(payload, expectedRelease)) {
        throw new Error(
          `healthy but not on expected release ${expectedRelease}; got ${JSON.stringify(
            releaseFields(payload),
          )}`,
        );
      }

      console.log(`${name} health check passed: ${url}`);
      return;
    } catch (error) {
      lastError = error;
      console.log(
        `${name} health check attempt ${attempt}/${maxAttempts} failed: ${error.message}`,
      );
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  throw new Error(
    `${name} health check failed after ${maxAttempts} attempts: ${lastError.message}`,
  );
}

function normalizeBaseUrl(value) {
  return value?.replace(/\/+$/, "") || "";
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function matchesExpectedRelease(payload, expected) {
  return Object.values(releaseFields(payload)).some(
    (value) => typeof value === "string" && value.startsWith(expected),
  );
}

function releaseFields(payload) {
  return {
    release: payload.release,
    gitCommit: payload.gitCommit,
    vercelGitCommitSha: payload.vercelGitCommitSha,
    renderGitCommit: payload.renderGitCommit,
  };
}

function booleanEnv(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value !== "0" && value !== "false" && value !== "no";
}
