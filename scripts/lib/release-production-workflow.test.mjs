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
    /VERCEL_PROJECT_ID="\$OPENCOMPANY_VERCEL_PROJECT_ID" bunx vercel pull --yes --environment=production/,
  );
  assert.match(
    workflow,
    /VERCEL_PROJECT_ID="\$MARKETING_VERCEL_PROJECT_ID" bunx vercel pull --yes --environment=production/,
  );
});

test("checks only web-owned production environment keys", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const stepStart = workflow.indexOf("- name: Check Vercel web env");
  const stepEnd = workflow.indexOf("- name: Pull Vercel web production env", stepStart);
  const step = workflow.slice(stepStart, stepEnd);
  const requiredKeysBlock = step.match(/const required = \[(?<keys>[\s\S]*?)\n\s*\];/u)?.groups
    ?.keys;

  assert.ok(requiredKeysBlock, "web required keys must remain explicit in the release workflow");
  assert.match(requiredKeysBlock, /"BLOB_READ_WRITE_TOKEN"/u);
  assert.match(requiredKeysBlock, /"DATABASE_URL"/u);
  for (const retiredKey of [
    "OPENCOMPANY_AUTHKIT_DOMAIN",
    "OPENCOMPANY_STRIPE_API_KEY",
    "OPENCOMPANY_STRIPE_CHECKOUT_ENABLED",
    "OPENCOMPANY_STRIPE_WEBHOOK_SECRET",
    "ELECTRIC_URL",
    "VERCEL_AI_GATEWAY_API_KEY",
  ]) {
    assert.doesNotMatch(requiredKeysBlock, new RegExp(`"${retiredKey}"`, "u"));
  }
  assert.doesNotMatch(workflow, /Check web billing env before production changes/u);
  assert.doesNotMatch(workflow, /check-goat-billing-production-env\.mjs/u);
});

test("requires PostHog configuration in the marketing Vercel project", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const stepStart = workflow.indexOf("- name: Check Vercel marketing project config");
  const stepEnd = workflow.indexOf("- name: Pull Vercel marketing production env", stepStart);
  const step = workflow.slice(stepStart, stepEnd);

  assert.match(step, /"NEXT_PUBLIC_OPENCOMPANY_POSTHOG_TOKEN"/u);
  assert.match(step, /"NEXT_PUBLIC_OPENCOMPANY_POSTHOG_HOST"/u);
  assert.match(step, /Missing marketing Vercel production env keys/u);
});

test("pins every release action to an immutable commit", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const actionReferences = Array.from(
    workflow.matchAll(/^\s*uses:\s*(?<reference>\S+)/gmu),
    (match) => match.groups.reference,
  );

  assert.ok(actionReferences.length > 0, "release workflow must use at least one action");
  for (const reference of actionReferences) {
    assert.match(reference, /@[a-f0-9]{40}$/u, `${reference} must use a full commit SHA`);
  }
});

function assertStepOrder(workflow, stepNames) {
  let previousIndex = -1;

  for (const stepName of stepNames) {
    const index = workflow.indexOf(`- name: ${stepName}`);
    assert.ok(index > previousIndex, `${stepName} must follow the preceding release step`);
    previousIndex = index;
  }
}
