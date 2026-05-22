#!/usr/bin/env node

const webUrl = normalizeBaseUrl(process.env.PRODUCTION_WEB_URL || process.env.WEB_URL);
const runnerUrl = normalizeBaseUrl(process.env.RUNNER_PUBLIC_URL);
const expectedRelease = process.env.EXPECTED_RELEASE;
const attempts = Number(process.env.SMOKE_ATTEMPTS ?? "30");
const delayMs = Number(process.env.SMOKE_DELAY_MS ?? "10000");

if (!webUrl || !runnerUrl) {
  console.error("PRODUCTION_WEB_URL/WEB_URL and RUNNER_PUBLIC_URL are required.");
  process.exit(1);
}

await checkUntilReady("web", `${webUrl}/api/healthz`, attempts, delayMs);
await checkUntilReady("runner", `${runnerUrl}/healthz`, attempts, delayMs);

console.log("Release smoke checks passed.");

async function checkUntilReady(name, url, maxAttempts, waitMs) {
  let lastError;

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
