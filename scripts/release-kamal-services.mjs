#!/usr/bin/env node

// Called by: .github/workflows/release-production.yml.
// Purpose: deploys the API and runner images that build-images pushed with `kamal deploy`, in
// parallel, then smokes each one. A failure in one app never stops the other.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  KAMAL_APPS,
  kamalDeployArgs,
  kamalDeployEnv,
  parseInfisicalEnvFile,
} from "./lib/release-kamal.mjs";
import { backendSurfaceResults } from "./lib/release-orchestration.mjs";

// Each app's Infisical folder, exported to a file by the workflow. Shared app keys cannot come
// from the job env because DATABASE_URL is the migration URL; release-kamal.mjs allowlists the
// runner's release-owned Vercel Sandbox credentials separately.
const ENV_FILE_VARIABLES = {
  api: "KAMAL_API_ENV_FILE",
  runner: "KAMAL_RUNNER_ENV_FILE",
};

const selectedSurfaces = parseArgs(process.argv.slice(2));
const releaseSha = requiredEnv("RELEASE_SHA");
const settled = await Promise.allSettled(selectedSurfaces.map(deployAndSmoke));
const settledBySurface = Object.fromEntries(
  selectedSurfaces.map((surface, index) => [surface, settled[index]]),
);
const results = backendSurfaceResults(selectedSurfaces, settledBySurface);

for (const surface of KAMAL_APPS) {
  writeOutput(`${surface}_result`, results[surface]);
  const outcome = settledBySurface[surface];
  if (outcome?.status === "rejected") {
    console.error(`${surface} release failed: ${outcome.reason.message}`);
  }
}
if (Object.values(results).includes("failure")) process.exit(1);

async function deployAndSmoke(surface) {
  const env = kamalDeployEnv({
    app: surface,
    jobEnv: process.env,
    appSecrets: readAppSecrets(surface),
  });
  await run(surface, "kamal", kamalDeployArgs(releaseSha), {
    cwd: fileURLToPath(new URL(`../apps/${surface}/`, import.meta.url)),
    env,
  });
  await run(surface, "bun", ["run", "release:smoke"], {
    env: {
      ...process.env,
      SMOKE_WEB: "false",
      SMOKE_API: String(surface === "api"),
      SMOKE_RUNNER: String(surface === "runner"),
      EXPECTED_API_RELEASE: surface === "api" ? releaseSha : "",
      EXPECTED_RUNNER_RELEASE: surface === "runner" ? releaseSha : "",
      SMOKE_API_ATTEMPTS: "12",
      SMOKE_RUNNER_ATTEMPTS: "12",
      SMOKE_DELAY_MS: "10000",
    },
  });
}

function readAppSecrets(surface) {
  return parseInfisicalEnvFile(readFileSync(requiredEnv(ENV_FILE_VARIABLES[surface]), "utf8"));
}

// Both deploys write to the same log, so each line carries its app.
function run(surface, command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const [stream, target] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      createInterface({ input: stream }).on("line", (line) =>
        target.write(`[${surface}] ${line}\n`),
      );
    }
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0]} exited with ${signal ?? `code ${code}`}.`));
    });
  });
}

function parseArgs(args) {
  const selected = [];
  for (const arg of args) {
    if (arg === "--api") selected.push("api");
    else if (arg === "--runner") selected.push("runner");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (selected.length === 0) throw new Error("Select at least one Kamal app.");
  return selected;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
