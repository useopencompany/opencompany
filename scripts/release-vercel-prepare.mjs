#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  cleanVercelWorkDirectory,
  missingProductionKeys,
  productionEnvironmentEntries,
  savePreparedVercelDirectory,
  surfaceConfig,
  validateProject,
} from "./lib/release-vercel.mjs";

await main().catch((error) => {
  cleanVercelWorkDirectory();
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const surface = parseSurface(process.argv.slice(2));
  const config = surfaceConfig(surface);
  const projectId = requiredEnv(config.projectEnv);
  const teamId = requiredEnv("VERCEL_ORG_ID");
  const token = requiredEnv("VERCEL_TOKEN");
  const project = await vercelRequest(`/v9/projects/${projectId}?teamId=${teamId}`, token);
  validateProject(surface, project, {
    projectId,
    webProjectId: process.env.OPENCOMPANY_VERCEL_PROJECT_ID?.trim(),
    marketingProjectId: process.env.MARKETING_VERCEL_PROJECT_ID?.trim(),
    docsProjectId: process.env.DOCS_VERCEL_PROJECT_ID?.trim(),
  });

  const { envs } = await vercelRequest(
    `/v10/projects/${projectId}/env?teamId=${teamId}&target=production`,
    token,
  );
  const missing = missingProductionKeys(surface, envs);
  if (missing.length > 0) {
    throw new Error(`Missing ${surface} Vercel production env keys: ${missing.join(", ")}`);
  }
  if (surface === "web") {
    await validateWebEnvironment(projectId, envs, teamId, token);
  }

  cleanVercelWorkDirectory();
  writeFileSync(
    ".vercel/project.json",
    `${JSON.stringify(
      {
        projectId: project.id,
        orgId: teamId,
        projectName: project.name,
        settings: {
          framework: project.framework ?? "nextjs",
          devCommand: project.devCommand ?? null,
          installCommand: project.installCommand ?? null,
          buildCommand: project.buildCommand ?? null,
          outputDirectory: project.outputDirectory ?? null,
          rootDirectory: project.rootDirectory ?? null,
          directoryListing: project.directoryListing ?? false,
          nodeVersion: project.nodeVersion ?? "24.x",
        },
      },
      null,
      2,
    )}\n`,
  );

  runVercel(
    ["pull", "--yes", "--environment=production", "--token", token, "--scope", teamId],
    projectId,
  );
  runVercel(
    ["build", "--prod", "--token", token, "--scope", teamId, "--project", projectId],
    projectId,
    surface === "web" ? { NODE_OPTIONS: "--max-old-space-size=6144" } : {},
  );

  const destination = `${process.env.RUNNER_TEMP?.trim() || tmpdir()}/opencompany-vercel-${surface}`;
  savePreparedVercelDirectory(destination);
  cleanVercelWorkDirectory();
  writeOutput("prepared_dir", destination);
  console.log(`Prepared ${surface} Vercel output at a runner-local path.`);
}

async function validateWebEnvironment(projectId, envs, teamId, token) {
  const expectedWebOrigin = new URL(requiredEnv("PRODUCTION_OPENCOMPANY_URL")).origin;
  const expectedApiOrigin = new URL(requiredEnv("PRODUCTION_API_URL")).origin;
  const expectedValues = new Map([
    ["OPENCOMPANY_NEXT_PUBLIC_APP_URL", expectedWebOrigin],
    ["OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI", `${expectedWebOrigin}/auth/callback`],
    ["OPENCOMPANY_API_ORIGIN", expectedApiOrigin],
    ["NEXT_PUBLIC_OPENCOMPANY_API_ORIGIN", expectedApiOrigin],
    ["WORKOS_COOKIE_DOMAIN", "opencompany.chat"],
  ]);
  const entries = productionEnvironmentEntries(envs);
  for (const [key, expected] of expectedValues) {
    const matches = entries.filter((env) => env.key === key);
    if (matches.length !== 1) {
      throw new Error(`web must have exactly one production ${key}; found ${matches.length}.`);
    }
    const env = await vercelRequest(
      `/v1/projects/${projectId}/env/${matches[0].id}?teamId=${teamId}`,
      token,
    );
    if (env.decrypted !== true || env.value?.trim() !== expected) {
      throw new Error(`Web Vercel production ${key} does not match the release contract.`);
    }
  }
}

async function vercelRequest(path, token) {
  const response = await fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Vercel API ${path} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function runVercel(args, projectId, extraEnv = {}) {
  const result = spawnSync("bunx", ["vercel", ...args], {
    env: {
      ...process.env,
      ...extraEnv,
      VERCEL_PROJECT_ID: projectId,
      OBSERVABILITY_RELEASE: process.env.RELEASE_SHA,
      NEXT_PUBLIC_OBSERVABILITY_RELEASE: process.env.RELEASE_SHA,
    },
    stdio: "inherit",
    timeout: 10 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Vercel ${args[0]} exited with code ${result.status}.`);
}

function parseSurface(args) {
  if (args.length !== 2 || args[0] !== "--surface") {
    throw new Error("Usage: release-vercel-prepare.mjs --surface <web|marketing|docs>.");
  }
  surfaceConfig(args[1]);
  return args[1];
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
