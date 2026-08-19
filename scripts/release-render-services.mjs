#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

import { renderSurfaceResults } from "./lib/release-orchestration.mjs";

const selectedSurfaces = parseArgs(process.argv.slice(2));
const settledEntries = await Promise.all(
  selectedSurfaces.map(async (surface) => {
    try {
      await deployAndSmoke(surface);
      return [surface, { status: "fulfilled" }];
    } catch (error) {
      return [surface, { status: "rejected", reason: error }];
    }
  }),
);
const settledBySurface = Object.fromEntries(settledEntries);
const results = renderSurfaceResults(selectedSurfaces, settledBySurface);

for (const surface of ["api", "runner"]) {
  writeOutput(`${surface}_result`, results[surface]);
  const outcome = settledBySurface[surface];
  if (outcome?.status === "rejected") {
    console.error(`${surface} release failed: ${outcome.reason.message}`);
  }
}
if (Object.values(results).includes("failure")) process.exit(1);

async function deployAndSmoke(surface) {
  const serviceId =
    surface === "api" ? requiredEnv("RENDER_API_SERVICE_ID") : requiredEnv("RENDER_SERVICE_ID");
  await run("bun", ["run", "release:render"], {
    ...process.env,
    RENDER_SERVICE_ID: serviceId,
    RENDER_DEPLOY_TIMEOUT_MS: process.env.RENDER_DEPLOY_TIMEOUT_MS ?? "1200000",
  });
  await run("bun", ["run", "release:smoke"], {
    ...process.env,
    SMOKE_WEB: "false",
    SMOKE_API: String(surface === "api"),
    SMOKE_RUNNER: String(surface === "runner"),
    EXPECTED_API_RELEASE: surface === "api" ? requiredEnv("RELEASE_SHA") : "",
    EXPECTED_RUNNER_RELEASE: surface === "runner" ? requiredEnv("RELEASE_SHA") : "",
    SMOKE_API_ATTEMPTS: "12",
    SMOKE_RUNNER_ATTEMPTS: "12",
    SMOKE_DELAY_MS: "10000",
  });
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? `code ${code}`}.`));
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
  if (selected.length === 0) throw new Error("Select at least one Render surface.");
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
