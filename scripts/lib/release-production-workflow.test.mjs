import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../.github/workflows/release-production.yml", import.meta.url);

test("verifies the exact main commit before release planning and production", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assertStepOrder(workflow, ["context:", "verify:", "plan:", "release:"]);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/verify\.yml/u);
  assert.match(workflow, /head_sha: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /^ {2}plan:\n[\s\S]*?needs: verify/mu);
  assert.match(workflow, /^ {2}release:\n[\s\S]*?needs: plan/mu);
  assert.doesNotMatch(workflow, /workflow_run:/u);
});

test("builds Vercel outputs before migrations and rechecks main before deploys", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assertStepOrder(workflow, [
    "Prepare web deployment",
    "Prepare marketing deployment",
    "Confirm release is current before production changes",
    "Run production migrations",
    "Confirm release is current before provider deploys",
    "Deploy and smoke marketing",
    "Deploy and smoke Render services",
    "Deploy web",
    "Smoke web release",
  ]);
  assert.doesNotMatch(workflow, /node <<['"]?NODE/u);
  assert.match(workflow, /timeout-minutes: 45/u);
  assert.match(workflow, /RENDER_DEPLOY_TIMEOUT_MS: "1200000"/u);
  assert.match(workflow, /VERCEL_DEPLOY_TIMEOUT_MS: "600000"/u);
});

test("tracks and finalizes every production surface independently", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  for (const surface of ["database", "api", "runner", "web", "marketing"]) {
    assert.match(workflow, new RegExp(`create --surface ${surface}`, "u"));
    assert.match(workflow, new RegExp(`finalize --surface ${surface}`, "u"));
  }
  assert.match(workflow, /steps\.deploy-render\.outputs\.api_result == 'success'/u);
  assert.match(workflow, /steps\.deploy-render\.outputs\.runner_result == 'success'/u);
  assert.match(workflow, /state=inactive/u);
});

test("production credentials are scoped to the release job", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const releaseStart = workflow.indexOf("  release:\n");
  const beforeRelease = workflow.slice(0, releaseStart);
  const release = workflow.slice(releaseStart);

  assert.doesNotMatch(beforeRelease, /id-token: write/u);
  assert.doesNotMatch(beforeRelease, /environment: production/u);
  assert.match(release, /environment: production/u);
  assert.match(release, /id-token: write/u);
  assert.match(release, /deployments: write/u);
});

function assertStepOrder(workflow, markers) {
  let previousIndex = -1;
  for (const marker of markers) {
    const needle = marker.endsWith(":") ? `  ${marker}` : `- name: ${marker}`;
    const index = workflow.indexOf(needle);
    assert.ok(index > previousIndex, `${marker} must follow the preceding workflow marker`);
    previousIndex = index;
  }
}
