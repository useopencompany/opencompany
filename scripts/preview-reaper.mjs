#!/usr/bin/env node

// Preview reconciler (issue #351 §7, Layer 3) — the real guarantee that nothing leaks.
// Treats previews as desired-vs-actual state and closes the gap:
//   desired = open PRs carrying the `preview` label
//   actual  = preview-tagged Render services + Neon `preview/pr-*` branches
// Any actual resource whose PR is closed / lost the label / exceeded max TTL is torn
// down (idempotent, tag-driven — it never touches prod). Missing previews for desired
// PRs are logged (auto-recreate is left to the next push; not yet automated).
//
// Usage: node scripts/preview-reaper.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { createNeonClient } from "./lib/preview-neon.mjs";
import { createRenderClient } from "./lib/preview-render.mjs";

const dryRun = process.argv.includes("--dry-run") || isTrue(process.env.PREVIEW_DRY_RUN);
const repo = requireEnv("GITHUB_REPOSITORY");
const githubToken = requireEnv("GITHUB_TOKEN");
const previewLabel = process.env.PREVIEW_LABEL?.trim() || "preview";
const maxAgeHours = nonNegativeNumberEnv("PREVIEW_MAX_AGE_HOURS", "24");

const renderApiKey = process.env.RENDER_API_KEY?.trim();
const neonApiKey = process.env.NEON_API_KEY?.trim();
const neonProjectId = process.env.NEON_PROJECT_ID?.trim();
const seedBranch = process.env.PREVIEW_SEED_BRANCH?.trim() || "preview-seed";

const RENDER_NAME = /^oc-preview-pr-(\d+)-/;
const NEON_NAME = /^preview\/pr-(\d+)$/;

await main().catch((error) => {
  console.error(`Preview reaper failed: ${error.message}`);
  process.exit(1);
});

async function main() {
  const desired = await fetchLabeledOpenPrs();
  log(
    `Desired previews (open + labeled "${previewLabel}"): ${[...desired].sort((a, b) => a - b).join(", ") || "none"}`,
  );

  // actual: map of pr -> { reasons:Set, oldestMs:number|undefined }
  const actual = new Map();
  await collectRender(actual);
  await collectNeon(actual);

  const now = Date.now();
  const toReap = new Set();
  for (const [pr, info] of actual) {
    if (!desired.has(pr)) {
      info.reasons.add("PR closed or lost the preview label");
      toReap.add(pr);
    }
    if (maxAgeHours > 0 && info.oldestMs && now - info.oldestMs > maxAgeHours * 3600 * 1000) {
      info.reasons.add(`exceeded max TTL (${maxAgeHours}h)`);
      toReap.add(pr);
    }
  }

  for (const pr of [...desired].filter((pr) => !actual.has(pr))) {
    log(
      `PR #${pr} is labeled-open but has no preview resources (will be provisioned on next push).`,
    );
  }

  if (toReap.size === 0) {
    log("Nothing to reap. Previews are in sync.");
    return;
  }

  for (const pr of [...toReap].sort((a, b) => a - b)) {
    const reasons = [...actual.get(pr).reasons].join("; ");
    log(`Reaping preview for PR #${pr}: ${reasons}${dryRun ? " [DRY RUN]" : ""}`);
    if (dryRun) continue;
    try {
      execFileSync("node", ["scripts/preview-teardown.mjs"], {
        stdio: "inherit",
        env: { ...process.env, PREVIEW_PR_NUMBER: String(pr) },
      });
    } catch (error) {
      console.error(
        `::warning::Teardown for PR #${pr} failed (will retry next run): ${error.message}`,
      );
    }
  }
}

async function collectRender(actual) {
  if (!renderApiKey) {
    log("RENDER_API_KEY unset; skipping Render enumeration.");
    return;
  }
  const render = createRenderClient({ apiKey: renderApiKey });
  const services = await render.listPreviewServices();
  for (const svc of services) {
    const match = svc?.name?.match(RENDER_NAME);
    if (!match) continue;
    const pr = Number(match[1]);
    record(actual, pr, svc.createdAt);
  }
}

async function collectNeon(actual) {
  if (!neonApiKey || !neonProjectId) {
    log("NEON_API_KEY/NEON_PROJECT_ID unset; skipping Neon enumeration.");
    return;
  }
  const neon = createNeonClient({
    apiKey: neonApiKey,
    projectId: neonProjectId,
    parentBranch: seedBranch,
  });
  const branches = neon.neon(["branches", "list"], { json: true });
  const list = Array.isArray(branches) ? branches : (branches.branches ?? []);
  for (const branch of list) {
    const match = branch?.name?.match(NEON_NAME);
    if (!match) continue;
    record(actual, Number(match[1]), branch.created_at ?? branch.createdAt);
  }
}

function record(actual, pr, createdAt) {
  if (!Number.isInteger(pr) || pr <= 0) return;
  const ms = createdAt ? Date.parse(createdAt) : undefined;
  const info = actual.get(pr) ?? { reasons: new Set(), oldestMs: undefined };
  if (ms && Number.isFinite(ms)) {
    info.oldestMs = info.oldestMs ? Math.min(info.oldestMs, ms) : ms;
  }
  actual.set(pr, info);
}

async function fetchLabeledOpenPrs() {
  // GitHub's issues endpoint includes PRs and supports label filtering.
  const desired = new Set();
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues?state=open&labels=${encodeURIComponent(previewLabel)}&per_page=100&page=${page}`,
      {
        headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
      },
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status} listing labeled PRs.`);
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) break;
    for (const item of items) {
      if (item.pull_request) desired.add(Number(item.number));
    }
    if (items.length < 100) break;
    page += 1;
  }
  return desired;
}

function log(message) {
  console.log(`[preview-reaper] ${message}`);
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
function nonNegativeNumberEnv(name, fallback) {
  const raw = process.env[name]?.trim() || fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} must be a non-negative number; got "${raw}".`);
    process.exit(1);
  }
  return value;
}
