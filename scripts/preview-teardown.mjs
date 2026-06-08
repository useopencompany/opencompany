#!/usr/bin/env node

// Tear down a per-PR preview stack — issue #351. Idempotent and safe to re-run (the
// reaper relies on this). Deletes the Render services (runner / Electric / Durable
// Streams), removes the Vercel alias, and deletes the Neon branch.
//
// Deleting the Neon branch also drops the branch's Postgres replication slot +
// publication, so a removed Electric service cannot leave an orphaned slot accumulating
// WAL (the storage-must-stay-in-sync constraint, issue #351 §4.4/§7).
//
// Uses the manifest (PREVIEW_MANIFEST env, the GitHub Deployment payload) for exact
// resource IDs when available, and falls back to deterministic names derived from the PR
// number so teardown still works if the manifest was lost.
//
// Usage: node scripts/preview-teardown.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { createNeonClient } from "./lib/preview-neon.mjs";
import { previewNames } from "./lib/preview-config.mjs";
import { createRenderClient } from "./lib/preview-render.mjs";

const dryRun = process.argv.includes("--dry-run") || isTrue(process.env.PREVIEW_DRY_RUN);
const pr = requireEnv("PREVIEW_PR_NUMBER");
const baseDomain = process.env.PREVIEW_BASE_DOMAIN?.trim();
const names = previewNames(pr, { baseDomain });
const manifest = parseManifest(process.env.PREVIEW_MANIFEST);

// Best-effort across all resources: one failure must not block the others.
const failures = [];

await teardownRender();
await teardownVercelAlias();
await teardownNeon();

if (failures.length) {
  console.error(`\nPreview teardown finished with ${failures.length} issue(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  // Non-zero so the reaper retries next hour, but every step was still attempted.
  process.exit(1);
}
log(`Preview teardown complete for PR #${pr}.`);

async function teardownRender() {
  const renderApiKey = process.env.RENDER_API_KEY?.trim();
  if (!renderApiKey) {
    log("RENDER_API_KEY unset; skipping Render teardown.");
    return;
  }
  const render = createRenderClient({ apiKey: renderApiKey });
  const targets = [
    { name: names.runnerService, id: manifest?.runnerServiceId },
    { name: names.electricService, id: manifest?.electricServiceId },
    { name: names.streamsService, id: manifest?.streamsServiceId },
  ];
  for (const target of targets) {
    try {
      if (dryRun) {
        log(`would delete Render service ${target.name}${target.id ? ` (${target.id})` : " (resolve by name)"}`);
        continue;
      }
      let id = target.id;
      if (!id) {
        const svc = await render.findServiceByName(target.name);
        id = svc?.id;
      }
      if (!id) {
        log(`Render service ${target.name} not found (already gone).`);
        continue;
      }
      await render.deleteService(id);
      log(`Deleted Render service ${target.name} (${id}).`);
    } catch (error) {
      failures.push(`Render ${target.name}: ${error.message}`);
    }
  }
}

async function teardownVercelAlias() {
  if (!names.alias) {
    log("No base domain; skipping Vercel alias teardown.");
    return;
  }
  try {
    if (dryRun) {
      log(`would remove Vercel alias ${names.alias}`);
      return;
    }
    const token = process.env.VERCEL_TOKEN?.trim();
    const args = ["vercel", "alias", "rm", names.alias, "--yes"];
    if (token) args.push("--token", token);
    execFileSync("bunx", args, { stdio: "inherit" });
    log(`Removed Vercel alias ${names.alias}.`);
  } catch (error) {
    // A missing alias exits non-zero; treat as already-removed rather than a failure.
    log(`Vercel alias ${names.alias} not removed (likely already gone): ${error.message}`);
  }
}

async function teardownNeon() {
  const neonApiKey = process.env.NEON_API_KEY?.trim();
  const neonProjectId = process.env.NEON_PROJECT_ID?.trim();
  if (!neonApiKey || !neonProjectId) {
    log("NEON_API_KEY/NEON_PROJECT_ID unset; skipping Neon teardown.");
    return;
  }
  const seedBranch = process.env.PREVIEW_SEED_BRANCH?.trim() || "preview-seed";
  try {
    if (dryRun) {
      log(`would delete Neon branch ${names.neonBranch} (drops its replication slot)`);
      return;
    }
    const neon = createNeonClient({ apiKey: neonApiKey, projectId: neonProjectId, parentBranch: seedBranch });
    const branch = neon.getBranchByName(names.neonBranch);
    if (!branch) {
      log(`Neon branch ${names.neonBranch} not found (already gone).`);
      return;
    }
    neon.deleteBranch(names.neonBranch);
    log(`Deleted Neon branch ${names.neonBranch}.`);
  } catch (error) {
    failures.push(`Neon ${names.neonBranch}: ${error.message}`);
  }
}

function parseManifest(value) {
  if (!value?.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    log("PREVIEW_MANIFEST is not valid JSON; falling back to derived names.");
    return null;
  }
}
function log(message) {
  console.log(`[preview-teardown] ${message}`);
}
function isTrue(value) {
  const raw = value?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}
function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required.`);
    process.exit(1);
  }
  return value;
}
