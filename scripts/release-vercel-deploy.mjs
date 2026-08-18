#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

import {
  cleanVercelWorkDirectory,
  restorePreparedVercelDirectory,
  vercelCurlArgs,
} from "./lib/release-vercel.mjs";

const TERMINAL_FAILURE_STATES = new Set(["ERROR", "CANCELED"]);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = requiredEnv("VERCEL_TOKEN");
  const teamId = requiredEnv("VERCEL_ORG_ID");
  const projectId = requiredEnv(options.projectEnv);

  try {
    if (options.preparedDir) {
      restorePreparedVercelDirectory(options.preparedDir);
    }

    await deployPreparedOutput(options, { token, teamId, projectId });
  } finally {
    if (options.preparedDir) cleanVercelWorkDirectory();
  }
}

async function deployPreparedOutput(options, { token, teamId, projectId }) {
  const deployTimeoutMs = Number(process.env.VERCEL_DEPLOY_TIMEOUT_MS ?? 10 * 60 * 1000);
  const readyTimeoutMs = Number(process.env.VERCEL_READY_TIMEOUT_MS ?? 10 * 60 * 1000);
  const pollDelayMs = Number(process.env.VERCEL_READY_POLL_MS ?? 2 * 1000);
  const deployOutput = await runCommand(
    "bunx",
    [
      "vercel",
      "deploy",
      "--prebuilt",
      "--prod",
      "--no-wait",
      "--skip-domain",
      "--yes",
      "--format",
      "json",
      "--token",
      token,
      "--scope",
      teamId,
      "--project",
      projectId,
    ],
    {
      env: { ...process.env, VERCEL_PROJECT_ID: projectId },
      timeoutMs: deployTimeoutMs,
    },
  );

  const deployment = await resolveDeploymentFromOutput(deployOutput, projectId, {
    token,
    teamId,
    timeoutMs: readyTimeoutMs,
    pollDelayMs,
  });

  await waitForDeploymentReady(deployment.id, {
    token,
    teamId,
    timeoutMs: readyTimeoutMs,
    pollDelayMs,
  });

  await runCommand(
    "bunx",
    [
      "vercel",
      "promote",
      deployment.id,
      "--yes",
      "--timeout",
      options.promoteTimeout,
      "--token",
      token,
      "--scope",
      teamId,
    ],
    {
      allowedFailurePattern: /already the current/i,
      timeoutMs: parseDuration(options.promoteTimeout) + 30 * 1000,
    },
  );

  if (options.smokePath) {
    await runCommand(
      "bunx",
      [
        ...vercelCurlArgs(options.smokePath, `https://${deployment.url}`, { token, teamId }),
        "--",
        "--fail-with-body",
        "--silent",
        "--show-error",
      ],
      { timeoutMs: 2 * 60 * 1000 },
    );
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `url=https://${deployment.url}\n`);
  }

  console.log(`Deployed ${options.label} to https://${deployment.url}`);
}

function parseArgs(args) {
  const parsed = {
    label: "Vercel",
    projectEnv: "OPENCOMPANY_VERCEL_PROJECT_ID",
    promoteTimeout: "3m",
    preparedDir: "",
    smokePath: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--label") {
      parsed.label = requireArg(args, ++index, arg);
    } else if (arg === "--project-env") {
      parsed.projectEnv = requireArg(args, ++index, arg);
    } else if (arg === "--promote-timeout") {
      parsed.promoteTimeout = requireArg(args, ++index, arg);
    } else if (arg === "--prepared-dir") {
      parsed.preparedDir = requireArg(args, ++index, arg);
    } else if (arg === "--smoke-path") {
      parsed.smokePath = requireArg(args, ++index, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireArg(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8 * 60 * 1000;
  console.log(
    `Running ${redactedCommand(command, args)} with ${formatDuration(timeoutMs)} timeout.`,
  );

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      reject(new Error(`${command} timed out after ${formatDuration(timeoutMs)}.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 || options.allowedFailurePattern?.test(output)) {
        resolve(output);
        return;
      }
      reject(new Error(`${command} exited with ${signal ?? `code ${code}`}.`));
    });
  });
}

function redactedCommand(command, args) {
  const redacted = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    redacted.push(arg);
    if (arg === "--token" || arg === "--scope") {
      index += 1;
      redacted.push("***");
    }
  }
  return [command, ...redacted].join(" ");
}

async function resolveDeploymentFromOutput(output, expectedProjectId, options) {
  const candidates = [...new Set(extractDeploymentCandidates(output))];
  if (candidates.length === 0) {
    throw new Error("Could not find a Vercel deployment URL in deploy output.");
  }

  const deadline = Date.now() + options.timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      try {
        const deployment = await fetchDeployment(candidate, options);
        if (deployment.projectId === expectedProjectId) {
          console.log(`Tracking Vercel deployment ${deployment.id} (${deployment.url}).`);
          return deployment;
        }
      } catch (error) {
        lastError = error;
      }
    }
    await delay(options.pollDelayMs);
  }

  throw new Error(
    `Could not resolve a deployment for the expected Vercel project. Last error: ${
      lastError instanceof Error ? lastError.message : "none"
    }`,
  );
}

function extractDeploymentCandidates(output) {
  const cleanOutput = stripAnsi(output);
  const fromJson = deploymentFromJsonOutput(cleanOutput);
  const fromUrls = [...cleanOutput.matchAll(/https:\/\/([a-zA-Z0-9.-]+\.vercel\.app)\b/g)].map(
    (match) => match[1],
  );

  return [fromJson?.id, fromJson?.url?.replace(/^https?:\/\//, ""), ...fromUrls].filter(Boolean);
}

function deploymentFromJsonOutput(output) {
  const trimmed = output.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
    return parsed.deployment ?? parsed;
  } catch {
    return null;
  }
}

async function waitForDeploymentReady(deploymentId, options) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const deployment = await fetchDeployment(deploymentId, options);
    const state = deployment.readyState ?? "UNKNOWN";
    const substate = deployment.readySubstate ? `/${deployment.readySubstate}` : "";
    console.log(`Vercel deployment ${deployment.id} status: ${state}${substate}`);

    if (state === "READY") {
      return deployment;
    }
    if (TERMINAL_FAILURE_STATES.has(state)) {
      throw new Error(`Vercel deployment ${deployment.id} ended with ${state}.`);
    }
    await delay(options.pollDelayMs);
  }

  throw new Error(`Timed out waiting for Vercel deployment ${deploymentId} to become READY.`);
}

async function fetchDeployment(deploymentIdOrUrl, options) {
  const response = await fetch(
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentIdOrUrl)}?teamId=${options.teamId}`,
    { headers: { Authorization: `Bearer ${options.token}` } },
  );

  if (!response.ok) {
    throw new Error(
      `Could not fetch Vercel deployment ${deploymentIdOrUrl}: ${response.status} ${response.statusText}`,
    );
  }

  return response.json();
}

function parseDuration(value) {
  const match = value.match(/^(\d+)(ms|s|m)$/);
  if (!match) {
    throw new Error(`Unsupported duration: ${value}`);
  }
  const amount = Number(match[1]);
  if (match[2] === "ms") return amount;
  if (match[2] === "s") return amount * 1000;
  return amount * 60 * 1000;
}

function formatDuration(value) {
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  if (value % 1000 === 0) return `${value / 1000}s`;
  return `${value}ms`;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
