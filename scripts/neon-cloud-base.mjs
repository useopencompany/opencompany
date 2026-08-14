#!/usr/bin/env node

import "./load-env.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { CLOUD_SANDBOX_PARENT_BRANCH } from "./lib/neon-branch-config.mjs";

const projectId = realEnv("NEON_PROJECT_ID");
const apiKey = realEnv("NEON_API_KEY");
const parentBranch = realEnv("NEON_PARENT_BRANCH") ?? "production";
const databaseName = realEnv("NEON_DATABASE_NAME") ?? "neondb";
const roleName = realEnv("NEON_ROLE_NAME") ?? "neondb_owner";
const MIGRATION_LOCK_ID = 824_946_302;
const neonConfigDir = join(tmpdir(), "opencompany-neonctl");

if (!projectId) fail("NEON_PROJECT_ID is required to refresh the cloud sandbox base branch.");
if (!apiKey) fail("NEON_API_KEY is required to refresh and protect the cloud sandbox base branch.");
if (parentBranch === CLOUD_SANDBOX_PARENT_BRANCH) {
  fail(`NEON_PARENT_BRANCH must not be ${CLOUD_SANDBOX_PARENT_BRANCH}.`);
}

await main();

async function main() {
  if (!migrationSourceMatchesMain()) {
    log("Skipping refresh because the migration source differs from origin/main.");
    return;
  }

  const branches = neonJson(["branches", "list"]);
  const parent = branches.find((branch) => branch.name === parentBranch);
  if (!parent) fail("The configured Neon parent branch does not exist.");

  let cloudBase = branches.find((branch) => branch.name === CLOUD_SANDBOX_PARENT_BRANCH);
  if (!cloudBase) {
    log("Creating the schema-only cloud base branch.");
    const created = neonJson([
      "branches",
      "create",
      "--name",
      CLOUD_SANDBOX_PARENT_BRANCH,
      "--parent",
      parentBranch,
      "--schema-only",
    ]);
    cloudBase = created.branch ?? created;
  } else if (cloudBase.parent_id && cloudBase.parent_id !== parent.id) {
    fail("The existing cloud base has an unexpected parent; refusing to modify it.");
  }

  const databaseUrl = neon([
    "connection-string",
    CLOUD_SANDBOX_PARENT_BRANCH,
    "--database-name",
    databaseName,
    "--role-name",
    roleName,
  ]);

  await withMigrationLock(databaseUrl, () => runMigrations(databaseUrl));

  if (!cloudBase.protected) {
    log("Protecting the cloud base from deletion and reset.");
    cloudBase = await protectBranch(cloudBase.id);
  }

  if (!cloudBase.protected) {
    fail(`Neon did not report ${CLOUD_SANDBOX_PARENT_BRANCH} as protected.`);
  }

  log("Cloud sandbox base is current and protected.");
}

function migrationSourceMatchesMain() {
  const paths = [
    "drizzle",
    "packages/db/drizzle.config.ts",
    "packages/db/src/schema.ts",
    "packages/db/src/product-schema.ts",
  ];
  const diff = spawnSync("git", ["diff", "--quiet", "origin/main", "--", ...paths], {
    stdio: "ignore",
  });
  if (diff.status === 1) return false;
  if (diff.status !== 0) {
    throw new Error("Could not compare the migration source with origin/main.");
  }

  const worktree = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ...paths],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (worktree.status !== 0) {
    throw new Error("Could not inspect migration source changes.");
  }
  return worktree.stdout.trim() === "";
}

async function withMigrationLock(databaseUrl, callback) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    log("Waiting for the cloud-base migration lock.");
    await client.query("select pg_advisory_lock($1::integer)", [MIGRATION_LOCK_ID]);
    await callback();
  } finally {
    try {
      await client.query("select pg_advisory_unlock($1::integer)", [MIGRATION_LOCK_ID]);
    } finally {
      await client.end();
    }
  }
}

function runMigrations(databaseUrl) {
  log("Applying pending migrations.");
  const result = spawnSync("bun", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`bun run db:migrate exited with ${result.status ?? "no status"}`);
  }
}

async function protectBranch(branchId) {
  const response = await fetch(
    `https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ branch: { protected: true } }),
    },
  );
  if (!response.ok) {
    throw new Error(`Neon branch protection failed with HTTP ${response.status}.`);
  }
  const payload = await response.json();
  return payload.branch ?? payload;
}

function neon(args) {
  mkdirSync(neonConfigDir, { recursive: true, mode: 0o700 });
  try {
    return execFileSync(
      "bunx",
      ["neonctl", ...args, "--project-id", projectId, "--config-dir", neonConfigDir],
      {
        encoding: "utf8",
        env: { ...process.env, NEON_API_KEY: apiKey },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch {
    throw new Error("Neon CLI command failed while refreshing the cloud base.");
  }
}

function neonJson(args) {
  const payload = JSON.parse(neon([...args, "--output", "json"]));
  return Array.isArray(payload) ? payload : (payload.branches ?? payload);
}

function realEnv(name) {
  const value = process.env[name]?.trim();
  if (!value || value === "..." || value.includes("...") || value.startsWith("replace-")) {
    return undefined;
  }
  return value;
}

function log(message) {
  console.log(`[cloud-base] ${message}`);
}

function fail(message) {
  throw new Error(message);
}
