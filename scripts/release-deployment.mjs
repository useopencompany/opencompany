#!/usr/bin/env node

import { appendFileSync } from "node:fs";

import { assertSurface, deploymentEnvironment, githubRequest } from "./lib/release-deployments.mjs";

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const token = requiredEnv("GITHUB_TOKEN");
  if (repository.split("/").filter(Boolean).length !== 2) {
    throw new Error("GITHUB_REPOSITORY must be owner/repo.");
  }

  if (options.command === "create") {
    const releaseSha = requiredEnv("RELEASE_SHA");
    const environment = deploymentEnvironment(options.surface);
    const deployment = await githubRequest(`/repos/${repository}/deployments`, {
      token,
      method: "POST",
      body: {
        ref: releaseSha,
        environment,
        auto_merge: false,
        required_contexts: [],
        transient_environment: false,
        production_environment: true,
        description: `Production ${options.surface} release ${releaseSha.slice(0, 7)}`,
      },
    });
    await setStatus({
      repository,
      token,
      deploymentId: deployment.id,
      surface: options.surface,
      state: "in_progress",
    });
    writeOutput("deployment_id", String(deployment.id));
    console.log(`Created ${environment} deployment ${deployment.id}.`);
    return;
  }

  await setStatus({
    repository,
    token,
    deploymentId: options.deploymentId,
    surface: options.surface,
    state: options.state,
    environmentUrl: options.environmentUrl,
  });
}

async function setStatus({ repository, token, deploymentId, surface, state, environmentUrl }) {
  const shortSha = requiredEnv("RELEASE_SHA").slice(0, 7);
  const runUrl = `${requiredEnv("GITHUB_SERVER_URL")}/${repository}/actions/runs/${requiredEnv(
    "GITHUB_RUN_ID",
  )}`;
  const descriptions = {
    in_progress: `Production ${surface} release ${shortSha} is in progress.`,
    success: `Production ${surface} release ${shortSha} succeeded.`,
    failure: `Production ${surface} release ${shortSha} failed.`,
    inactive: `Production ${surface} release ${shortSha} was blocked or superseded.`,
  };
  const body = {
    state,
    log_url: runUrl,
    environment: deploymentEnvironment(surface),
    description: descriptions[state],
  };
  const url = environmentUrl || defaultEnvironmentUrl(surface);
  if (url) body.environment_url = url;
  await githubRequest(`/repos/${repository}/deployments/${deploymentId}/statuses`, {
    token,
    method: "POST",
    body,
  });
  console.log(`Marked ${surface} deployment ${deploymentId} ${state}.`);
}

function parseArgs(args) {
  const [command, ...rest] = args;
  if (command !== "create" && command !== "finalize") {
    throw new Error("Usage: release-deployment.mjs <create|finalize> --surface <name> [...].");
  }
  const parsed = { command, surface: "", deploymentId: "", state: "", environmentUrl: "" };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!["--surface", "--deployment-id", "--state", "--environment-url"].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    if (flag === "--surface") parsed.surface = value;
    if (flag === "--deployment-id") parsed.deploymentId = value;
    if (flag === "--state") parsed.state = value;
    if (flag === "--environment-url") parsed.environmentUrl = value;
    index += 1;
  }
  assertSurface(parsed.surface);
  if (command === "finalize") {
    if (!/^\d+$/u.test(parsed.deploymentId)) throw new Error("--deployment-id is required.");
    if (!["success", "failure", "inactive"].includes(parsed.state)) {
      throw new Error("--state must be success, failure, or inactive.");
    }
  }
  return parsed;
}

function defaultEnvironmentUrl(surface) {
  if (surface === "web") return process.env.PRODUCTION_OPENCOMPANY_URL?.trim();
  if (surface === "api") return process.env.PRODUCTION_API_URL?.trim();
  if (surface === "runner") return process.env.RUNNER_PUBLIC_URL?.trim();
  if (surface === "marketing") return process.env.PRODUCTION_MARKETING_URL?.trim();
  return "";
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
