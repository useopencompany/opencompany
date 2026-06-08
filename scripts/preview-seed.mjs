#!/usr/bin/env node

// Create / refresh the sanitized `preview-seed` Neon branch (issue #351). Per-PR preview
// branches fork from this — NEVER from prod `main` — so previews carry realistic shape
// without prod PII.
//
// Usage:
//   node scripts/preview-seed.mjs                 # create the seed branch if missing, print next steps
//   node scripts/preview-seed.mjs --refresh       # delete + re-fork the seed from prod (then re-sanitize!)
//   node scripts/preview-seed.mjs --apply-sanitize  # also run the sanitization SQL (needs psql)
//
// Auth: uses NEON_API_KEY if set (CI), otherwise local `neon auth` browser context (dev).
// NEON_PROJECT_ID and NEON_PARENT_BRANCH (the prod branch to fork) are required.

import "./load-env.mjs";
import { execFileSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const refresh = args.has("--refresh");
const applySanitize = args.has("--apply-sanitize");

const projectId = realEnv("NEON_PROJECT_ID");
const parentBranch = realEnv("NEON_PARENT_BRANCH");
const apiKey = realEnv("NEON_API_KEY");
const seedBranch = realEnv("PREVIEW_SEED_BRANCH") || "preview-seed";
const databaseName = realEnv("NEON_DATABASE_NAME") || "neondb";
const roleName = realEnv("NEON_ROLE_NAME");

if (!projectId) fail("NEON_PROJECT_ID is required (set it in .env.local or the environment).");
if (!parentBranch) {
  fail("NEON_PARENT_BRANCH is required — the prod branch to fork the seed from (e.g. 'main' or 'production').");
}

main();

function main() {
  const branches = neonJson(["branches", "list"]);
  const list = Array.isArray(branches) ? branches : (branches.branches ?? []);
  let branch = list.find((b) => b.name === seedBranch);

  if (branch && refresh) {
    log(`Deleting existing seed branch ${seedBranch} for refresh…`);
    neon(["branches", "delete", seedBranch]);
    branch = undefined;
  }

  if (!branch) {
    log(`Creating seed branch ${seedBranch} from ${parentBranch}…`);
    const created = neonJson(["branches", "create", "--name", seedBranch, "--parent", parentBranch]);
    branch = created.branch ?? created;
  } else {
    log(`Seed branch ${seedBranch} already exists (${branch.id}). Use --refresh to re-fork.`);
  }

  const pooled = neon([
    "connection-string", seedBranch, "--pooled", "--database-name", databaseName,
    ...(roleName ? ["--role-name", roleName] : []),
  ]);
  const direct = pooled.replace("-pooler.", ".");

  log(`Seed branch ready: ${seedBranch} (${branch.id ?? "?"})`);

  if (applySanitize) {
    runSanitize(direct);
  } else {
    console.log("\nNext steps:");
    console.log("  1) Sanitize the seed (removes prod PII/secrets) — REQUIRED before using it:");
    console.log(`       psql "${maskUrl(direct)}" -f scripts/sql/preview-seed-sanitize.sql`);
    console.log("     (or run this script with --apply-sanitize, or paste the SQL in the Neon Console)");
    console.log("  2) (optional hardening) apply scripts/sql/preview-seed-electric-role.sql after testing.");
    console.log(`  3) Set the repo var PREVIEW_SEED_BRANCH=${seedBranch} (or keep the default).`);
  }
}

function runSanitize(directUrl) {
  if (!hasPsql()) {
    fail(
      "psql not found — cannot run sanitization automatically. Install psql or run the SQL via the Neon Console:\n" +
        "  scripts/sql/preview-seed-sanitize.sql",
    );
  }
  log("Running sanitization SQL against the seed branch…");
  execFileSync("psql", [directUrl, "-v", "ON_ERROR_STOP=1", "-f", "scripts/sql/preview-seed-sanitize.sql"], {
    stdio: "inherit",
  });
  log("Sanitization complete. The seed branch is safe to fork previews from.");
}

function neon(neonctlArgs) {
  const full = ["neonctl", ...neonctlArgs, "--project-id", projectId];
  if (apiKey) full.push("--api-key", apiKey);
  return execFileSync("bunx", full, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}
function neonJson(neonctlArgs) {
  return JSON.parse(neon([...neonctlArgs, "--output", "json"]));
}
function hasPsql() {
  try {
    execFileSync("psql", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function maskUrl(url) {
  return url.replace(/:\/\/([^:]+):[^@]+@/, "://$1:****@");
}
function realEnv(name) {
  const value = process.env[name];
  if (!value || value === "..." || value.includes("...") || value.startsWith("replace-")) return undefined;
  return value;
}
function log(message) {
  console.log(`[preview-seed] ${message}`);
}
function fail(message) {
  console.error(message);
  process.exit(1);
}
