#!/usr/bin/env node

// Called by: .github/workflows/release-production.yml and root `bun run release:smoke`.
// Purpose: polls production web and runner health checks after deployment.

import { execFileSync } from "node:child_process";

import { expectedReleaseFor } from "./lib/release-smoke.mjs";

const webUrl = normalizeBaseUrl(process.env.GOAT_URL || process.env.PRODUCTION_GOAT_URL);
const webVercelDeployment = normalizeBaseUrl(process.env.SMOKE_GOAT_VERCEL_DEPLOYMENT);
const runnerUrl = normalizeBaseUrl(process.env.RUNNER_PUBLIC_URL);
const attempts = Number(process.env.SMOKE_ATTEMPTS ?? "30");
const webAttempts = Number(process.env.SMOKE_GOAT_ATTEMPTS ?? attempts);
const runnerAttempts = Number(process.env.SMOKE_RUNNER_ATTEMPTS ?? attempts);
const delayMs = Number(process.env.SMOKE_DELAY_MS ?? "10000");
const checkWeb = booleanEnv("SMOKE_GOAT", true);
const checkRunner = booleanEnv("SMOKE_RUNNER", true);

if (checkWeb && !webUrl && !webVercelDeployment) {
  console.error("GOAT_URL, PRODUCTION_GOAT_URL, or SMOKE_GOAT_VERCEL_DEPLOYMENT is required.");
  process.exit(1);
}

if (checkRunner && !runnerUrl) {
  console.error("RUNNER_PUBLIC_URL is required.");
  process.exit(1);
}

const checks = [];

if (checkWeb) {
  checks.push(checkUntilReady("web", healthTarget("web"), webAttempts, delayMs));
}

if (checkRunner) {
  checks.push(checkUntilReady("runner", `${runnerUrl}/healthz`, runnerAttempts, delayMs));
}

await Promise.all(checks);

console.log("Release smoke checks passed.");

async function checkUntilReady(name, url, maxAttempts, waitMs) {
  let lastError;
  const expectedRelease = expectedReleaseFor(name);

  console.log(`${name} health check target: ${url}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const body = await readHealthBody(name, url);
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

async function readHealthBody(name, url) {
  if (name === "web" && webVercelDeployment) {
    const args = ["vercel", "curl", "/api/healthz", "--deployment", url];
    if (process.env.VERCEL_TOKEN?.trim()) args.push("--token", process.env.VERCEL_TOKEN.trim());
    return execFileSync("bunx", args, {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${body.slice(0, 200)}`);
  }
  return body;
}

function healthTarget(name) {
  if (name !== "web") {
    throw new Error(`Unknown health target: ${name}`);
  }
  return webVercelDeployment || `${webUrl}/api/healthz`;
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
