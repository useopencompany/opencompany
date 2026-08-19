#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { findLastSuccessfulSurfaceSha } from "./lib/release-deployments.mjs";
import {
  databaseChanged,
  finalizeReleasePlan,
  planReleaseSurfaces,
  RELEASE_STATE_SURFACES,
  RELEASE_SURFACES,
} from "./lib/release-scope.mjs";

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const headSha = requiredEnv("RELEASE_SHA");
  if (!isFullSha(headSha) || !commitExists(headSha)) {
    throw new Error("RELEASE_SHA must identify a checked-out full Git commit SHA.");
  }

  const baseBySurface = Object.fromEntries(RELEASE_STATE_SURFACES.map((surface) => [surface, ""]));
  if (!options.deployAll) {
    const repository = requiredEnv("GITHUB_REPOSITORY");
    const token = requiredEnv("GITHUB_TOKEN");
    await Promise.all(
      RELEASE_STATE_SURFACES.map(async (surface) => {
        try {
          baseBySurface[surface] = await findLastSuccessfulSurfaceSha({
            repository,
            surface,
            token,
          });
        } catch (error) {
          console.warn(
            `Could not resolve the last successful ${surface} deployment; forcing that surface: ${error.message}`,
          );
        }
      }),
    );
  }

  const rangeCache = new Map();
  const requestedSurfaces = {};
  for (const surface of RELEASE_SURFACES) {
    requestedSurfaces[surface] =
      options.deployAll ||
      rangeSelectsSurface(surface, baseBySurface[surface], headSha, rangeCache);
  }
  const databaseHasChanges =
    options.deployAll || rangeSelectsDatabase(baseBySurface.database, headSha, rangeCache);
  const plan = finalizeReleasePlan({
    requestedSurfaces,
    databaseHasChanges,
    deployAll: options.deployAll,
    deployApi: options.deployApi,
    deployRunner: options.deployRunner,
  });

  const selected = RELEASE_STATE_SURFACES.filter((surface) => plan[surface]);
  console.log(`Production release plan: ${selected.join(", ") || "no production changes"}.`);
  for (const surface of RELEASE_STATE_SURFACES) {
    const base = baseBySurface[surface];
    console.log(
      `${surface}: ${plan[surface] ? "selected" : "unchanged"} (base ${base ? base.slice(0, 7) : "none"}).`,
    );
    writeOutput(surface, String(plan[surface]));
    writeOutput(`${surface}_base`, base);
  }
  writeOutput("any", String(selected.length > 0));
}

function rangeSelectsSurface(surface, baseSha, headSha, rangeCache) {
  const range = readRange(baseSha, headSha, rangeCache);
  if (!range) return true;
  return planReleaseSurfaces(range)[surface];
}

function rangeSelectsDatabase(baseSha, headSha, rangeCache) {
  const range = readRange(baseSha, headSha, rangeCache);
  return !range || databaseChanged(range);
}

function readRange(baseSha, headSha, rangeCache) {
  if (!isFullSha(baseSha) || !commitExists(baseSha) || !isAncestor(baseSha, headSha)) return null;
  if (rangeCache.has(baseSha)) return rangeCache.get(baseSha);

  try {
    const range = {
      affectedPackages: readAffectedPackages(baseSha, headSha),
      changedFiles: readChangedFiles(baseSha, headSha),
    };
    rangeCache.set(baseSha, range);
    return range;
  } catch (error) {
    console.warn(
      `Could not calculate ${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}: ${error.message}`,
    );
    return null;
  }
}

function readAffectedPackages(baseSha, headSha) {
  const output = execFileSync("bun", ["--bun", "turbo", "ls", "--affected", "--output=json"], {
    encoding: "utf8",
    env: { ...process.env, TURBO_SCM_BASE: baseSha, TURBO_SCM_HEAD: headSha },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const items = JSON.parse(output)?.packages?.items;
  if (!Array.isArray(items) || items.some((item) => typeof item?.name !== "string")) {
    throw new Error("Turbo returned an invalid affected-package payload.");
  }
  return items.map((item) => item.name);
}

function readChangedFiles(baseSha, headSha) {
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACDMRTUXB", baseSha, headSha], {
    encoding: "utf8",
  })
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function parseArgs(args) {
  const parsed = { deployAll: false, deployApi: true, deployRunner: true };
  for (const arg of args) {
    if (arg === "--all") parsed.deployAll = true;
    else if (arg === "--skip-api") parsed.deployApi = false;
    else if (arg === "--skip-runner") parsed.deployRunner = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function isAncestor(baseSha, headSha) {
  return (
    spawnSync("git", ["merge-base", "--is-ancestor", baseSha, headSha], {
      stdio: "ignore",
    }).status === 0
  );
}

function commitExists(sha) {
  return spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" }).status === 0;
}

function isFullSha(value) {
  return /^[a-f0-9]{40}$/iu.test(value ?? "");
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
