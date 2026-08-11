#!/usr/bin/env node

// Called by: .github/workflows/release-production.yml and root `bun run release:scope`.
// Purpose: plans the production surfaces changed since the last successful release.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { planReleaseSurfaces, RELEASE_SURFACES } from "./lib/release-scope.mjs";

await main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let plan;
  let reason;

  if (options.deployAll) {
    plan = planReleaseSurfaces({
      deployAll: true,
      deployApi: options.deployApi,
      deployRunner: options.deployRunner,
    });
    reason = "full release requested";
  } else if (!isAncestor(options.base, options.head)) {
    console.warn(
      `Release base ${shortSha(options.base)} is not an ancestor of ${shortSha(options.head)}; deploying every surface.`,
    );
    plan = planReleaseSurfaces({
      deployAll: true,
      deployApi: options.deployApi,
      deployRunner: options.deployRunner,
    });
    reason = "release base was not an ancestor";
  } else {
    try {
      const affectedPackages = readAffectedPackages(options.base, options.head);
      const changedFiles = readChangedFiles(options.base, options.head);
      plan = planReleaseSurfaces({
        affectedPackages,
        changedFiles,
        deployApi: options.deployApi,
        deployRunner: options.deployRunner,
      });
      reason = `${shortSha(options.base)}..${shortSha(options.head)}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not calculate the release scope (${message}); deploying every surface.`);
      plan = planReleaseSurfaces({
        deployAll: true,
        deployApi: options.deployApi,
        deployRunner: options.deployRunner,
      });
      reason = "release scope calculation failed";
    }
  }

  const selected = RELEASE_SURFACES.filter((surface) => plan[surface]);
  console.log(
    `Production release scope (${reason}): ${selected.join(", ") || "no application deploys"}.`,
  );

  for (const surface of RELEASE_SURFACES) {
    writeGithubOutput(surface, String(plan[surface]));
  }
  writeGithubOutput("any", String(selected.length > 0));
}

function parseArgs(args) {
  const options = {
    base: "",
    head: "",
    deployAll: false,
    deployApi: true,
    deployRunner: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all") {
      options.deployAll = true;
    } else if (arg === "--skip-api") {
      options.deployApi = false;
    } else if (arg === "--skip-runner") {
      options.deployRunner = false;
    } else if (arg === "--base") {
      options.base = requireSha(args, ++index, arg);
    } else if (arg === "--head") {
      options.head = requireSha(args, ++index, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.deployAll && (!options.base || !options.head)) {
    throw new Error("--base and --head are required unless --all is used.");
  }

  return options;
}

function requireSha(args, index, flag) {
  const value = args[index];
  if (!value || !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`${flag} requires a full Git commit SHA.`);
  }
  return value;
}

function isAncestor(base, head) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", base, head], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function readAffectedPackages(base, head) {
  const output = execFileSync("bun", ["--bun", "turbo", "ls", "--affected", "--output=json"], {
    encoding: "utf8",
    env: { ...process.env, TURBO_SCM_BASE: base, TURBO_SCM_HEAD: head },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const payload = JSON.parse(output);
  const items = payload?.packages?.items;

  if (!Array.isArray(items) || items.some((item) => typeof item?.name !== "string")) {
    throw new Error("Turbo returned an invalid affected-package payload.");
  }

  return items.map((item) => item.name);
}

function readChangedFiles(base, head) {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACDMRTUXB", base, head],
    { encoding: "utf8" },
  );
  return output
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function writeGithubOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function shortSha(value) {
  return value.slice(0, 7);
}
