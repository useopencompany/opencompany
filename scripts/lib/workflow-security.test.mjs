import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const workflowDirectory = new URL("../../.github/workflows/", import.meta.url);
const pullRequestWorkflowUrl = new URL("ci.yml", workflowDirectory);
const verifyWorkflowUrl = new URL("verify.yml", workflowDirectory);
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

test("the pull request path remains credential-free", async () => {
  const caller = await readFile(pullRequestWorkflowUrl, "utf8");
  const verifier = await readFile(verifyWorkflowUrl, "utf8");
  const combined = `${caller}\n${verifier}`;

  assert.match(caller, /^on:\n\s+pull_request:\n\s+branches: \[main\]/mu);
  assert.match(verifier, /^on:\n\s+workflow_call:/mu);
  assert.match(caller, /^permissions:\n\s+contents: read$/mu);
  assert.match(verifier, /^permissions:\n\s+contents: read$/mu);
  assert.match(combined, /persist-credentials: false/u);

  for (const forbidden of [
    /pull_request_target:/u,
    /workflow_run:/u,
    /\$\{\{\s*secrets\./u,
    /\bid-token:\s*write\b/u,
    /\bdeployments:\s*write\b/u,
    /^\s*environment:/mu,
    /runs-on:\s*self-hosted/u,
    /TURBO_TOKEN/u,
    /TURBO_TEAM/u,
    /useblacksmith\/cache@/u,
  ]) {
    assert.doesNotMatch(combined, forbidden);
  }

  for (const command of [
    "bun install --frozen-lockfile",
    "node scripts/check-schema-migration.mjs",
    "bun run db:migrations:check",
    "node --check scripts/setup.mjs",
    "bun run format:check",
    "bun run boundary:check",
    "bun --filter @opencompany/protocol openapi:check",
    "bun --bun turbo run lint typecheck --concurrency=2",
    "bun --bun turbo run test --concurrency=2",
    "-- --maxWorkers=2",
    "bun --bun turbo run build --concurrency=2",
    "node --test scripts/lib/*.test.mjs",
  ]) {
    assert.ok(combined.includes(command), `PR verification must run: ${command}`);
  }

  assert.match(caller, /actions\/dependency-review-action@[a-f0-9]{40}/u);
  assert.match(verifier, /actions\/cache\/restore@[a-f0-9]{40}/u);
  assert.match(verifier, /actions\/cache\/save@[a-f0-9]{40}/u);
  assert.match(verifier, /inputs\.cache_write/u);
  assert.match(verifier, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(verifier, /trufflesecurity\/trufflehog@[a-f0-9]{40}/u);
  assert.doesNotMatch(verifier, /^\s+version:/mu);
});

test("the PR gate aggregates every direct gate job", async () => {
  const workflow = await readFile(pullRequestWorkflowUrl, "utf8");
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

test("production verifies main before entering the privileged release job", async () => {
  const workflow = await readFile(releaseWorkflowUrl, "utf8");

  assert.match(workflow, /^on:\n\s+push:\n\s+branches: \[main\]\n\s+workflow_dispatch:/mu);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/verify\.yml/u);
  assert.match(workflow, /head_sha: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /environment: production/u);
  assert.doesNotMatch(workflow, /pull_request_target:/u);
  assert.doesNotMatch(workflow, /pull_request:/u);
  assert.doesNotMatch(workflow, /workflow_run:/u);
});
