import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../.github/workflows/release-production.yml", import.meta.url);

test("pulls current Vercel production env before every prebuilt build", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assertStepOrder(workflow, [
    "Check Vercel web env",
    "Pull Vercel web production env",
    "Build web",
    "Deploy web",
  ]);
  assertStepOrder(workflow, [
    "Check Vercel marketing project config",
    "Pull Vercel marketing production env",
    "Build marketing",
    "Deploy marketing",
  ]);

  assert.match(
    workflow,
    /VERCEL_PROJECT_ID="\$GOAT_VERCEL_PROJECT_ID" bunx vercel pull --yes --environment=production/,
  );
  assert.match(
    workflow,
    /VERCEL_PROJECT_ID="\$MARKETING_VERCEL_PROJECT_ID" bunx vercel pull --yes --environment=production/,
  );
});

function assertStepOrder(workflow, stepNames) {
  let previousIndex = -1;

  for (const stepName of stepNames) {
    const index = workflow.indexOf(`- name: ${stepName}`);
    assert.ok(index > previousIndex, `${stepName} must follow the preceding release step`);
    previousIndex = index;
  }
}
