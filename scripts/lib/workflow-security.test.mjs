import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const workflowDirectory = new URL("../../.github/workflows/", import.meta.url);
const pullRequestWorkflowUrl = new URL("ci.yml", workflowDirectory);
const releaseWorkflowUrl = new URL("release-production.yml", workflowDirectory);

test("every third-party workflow action is pinned to a full commit SHA", async () => {
  const workflowFiles = (await readdir(workflowDirectory)).filter((name) => name.endsWith(".yml"));

  for (const workflowFile of workflowFiles) {
    const workflow = await readFile(new URL(workflowFile, workflowDirectory), "utf8");
    for (const match of workflow.matchAll(/^\s*uses:\s*(?<action>[^\s#]+)(?:\s+#.*)?$/gmu)) {
      const action = match.groups?.action;
      if (!action || action.startsWith("./")) continue;

      const separator = action.lastIndexOf("@");
      assert.notEqual(separator, -1, `${workflowFile}: ${action} has no ref`);
      assert.match(
        action.slice(separator + 1),
        /^[a-f0-9]{40}$/u,
        `${workflowFile}: ${action} is not pinned to a full commit SHA`,
      );
    }
  }
});

test("the pull request gate is isolated and credential-free", async () => {
  const workflow = await readFile(pullRequestWorkflowUrl, "utf8");

  assert.match(workflow, /^on:\n\s+pull_request:\n\s+branches: \[main\]/mu);
  assert.match(workflow, /^permissions:\n\s+contents: read$/mu);
  assert.match(workflow, /persist-credentials: false/u);

  // The workflow may run on Blacksmith for speed, but never on a raw self-hosted
  // runner, and never with any credential that could reach deploy or the cache
  // remote. Speed comes from `--affected` and the token-free Blacksmith cache.
  for (const forbidden of [
    /pull_request_target:/u,
    /workflow_run:/u,
    /\$\{\{\s*secrets\./u,
    /\bid-token:\s*write\b/u,
    /\bdeployments:\s*write\b/u,
    /^\s*environment:/mu,
    /runs-on:\s*self-hosted/u,
    /actions\/cache@/u,
    /TURBO_TOKEN/u,
    /TURBO_TEAM/u,
  ]) {
    assert.doesNotMatch(workflow, forbidden);
  }

  for (const command of [
    "bun install --frozen-lockfile",
    "node scripts/check-schema-migration.mjs",
    "bun run db:migrations:check",
    "node --check scripts/setup.mjs",
    "bun run format:check",
    "bun run boundary:check",
    "bun --filter @opencompany/protocol openapi:check",
    "bun --bun turbo run lint typecheck build test --affected",
    "node --test scripts/lib/*.test.mjs",
  ]) {
    assert.ok(workflow.includes(command), `PR gate must run: ${command}`);
  }

  // The persistent cache must be the token-free Blacksmith cache, pinned to a SHA.
  assert.match(workflow, /useblacksmith\/cache@[a-f0-9]{40}/u);

  assert.match(workflow, /trufflesecurity\/trufflehog@[a-f0-9]{40}/u);
  assert.match(workflow, /base: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(workflow, /head: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
});

test("the PR gate aggregates every job into one required status check", async () => {
  const workflow = await readFile(pullRequestWorkflowUrl, "utf8");

  // Top-level job ids are the two-space-indented keys inside the `jobs:` block.
  // Branch protection requires only the `gate` check, so every other job must be
  // a dependency of `gate`; otherwise a job could fail without blocking merges.
  const jobsBlock = workflow.slice(workflow.indexOf("\njobs:\n"));
  const jobIds = [...jobsBlock.matchAll(/^ {2}([a-z][\w-]*):\n/gmu)].map((match) => match[1]);
  assert.ok(jobIds.includes("gate"), "the workflow must define a `gate` job");

  const needsMatch = jobsBlock.match(/^ {2}gate:[\s\S]*?\n {4}needs: \[([^\]]+)\]/mu);
  assert.ok(needsMatch, "the gate job must declare `needs`");
  const gateNeeds = needsMatch[1].split(",").map((name) => name.trim());

  for (const jobId of jobIds) {
    if (jobId === "gate") continue;
    assert.ok(gateNeeds.includes(jobId), `the gate job must depend on the ${jobId} job`);
  }

  assert.match(workflow, /^ {2}gate:\n {4}name: PR gate$/mu);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(workflow, /join\(needs\.\*\.result/u);
});

test("production can only run from a trusted post-merge event", async () => {
  const workflow = await readFile(releaseWorkflowUrl, "utf8");

  assert.match(workflow, /^on:\n\s+push:\n\s+branches: \[main\]\n\s+workflow_dispatch:/mu);
  assert.match(workflow, /RELEASE_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /ref: \$\{\{ env\.RELEASE_SHA \}\}/u);
  assert.doesNotMatch(workflow, /pull_request_target:/u);
  assert.doesNotMatch(workflow, /pull_request:/u);
  assert.doesNotMatch(workflow, /workflow_run:/u);
});
