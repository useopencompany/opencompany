import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const preflightUrl = new URL("../release-preflight.mjs", import.meta.url);
const workflowUrl = new URL("../../.github/workflows/release-production.yml", import.meta.url);
const renderUrl = new URL("../../render.yaml", import.meta.url);

test("production preflight follows the deployed runtime boundaries", async () => {
  const [source, workflow, render] = await Promise.all([
    readFile(preflightUrl, "utf8"),
    readFile(workflowUrl, "utf8"),
    readFile(renderUrl, "utf8"),
  ]);
  const groups = readGroups(source);

  assertIncludes(groups.web.required, ["DATABASE_URL", "BLOB_READ_WRITE_TOKEN"]);
  assertExcludes(
    [...groups.web.required, ...groups.web.optional],
    [
      "GOAT_AUTHKIT_DOMAIN",
      "GOAT_STRIPE_API_KEY",
      "GOAT_STRIPE_CHECKOUT_ENABLED",
      "GOAT_STRIPE_WEBHOOK_SECRET",
      "ELECTRIC_URL",
      "VERCEL_AI_GATEWAY_API_KEY",
    ],
  );

  assertExcludes([...groups.api.required, ...groups.api.optional], ["BETTER_STACK_ERRORS_DSN"]);

  assertIncludes(groups.runner.required, [
    "BLOB_READ_WRITE_TOKEN",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "MONID_API_KEY",
    "RUNNER_GOAT_TASK_WORKER_ENABLED",
  ]);
  assertExcludes(
    [...groups.runner.required, ...groups.runner.optional],
    [
      "BROWSERBASE_API_KEY",
      "BROWSERBASE_PROJECT_ID",
      "GOAT_BROWSER_PROFILES_ENABLED",
      "GOAT_BROWSER_PROFILES_KILL_SWITCH",
    ],
  );
  assert.equal(groups.runner.conditional, undefined);

  for (const [name, group] of Object.entries(groups)) {
    const keys = [...group.required, ...group.optional];
    assert.equal(new Set(keys).size, keys.length, `${name} preflight keys must be unique`);
  }

  assert.deepEqual(readWorkflowWebRequired(workflow).sort(), [...groups.web.required].sort());
  assert.deepEqual(readRenderKeys(render, "opencompany-api").sort(), groupKeys(groups.api).sort());
  assert.deepEqual(
    readRenderKeys(render, "opencompany-runner").sort(),
    groupKeys(groups.runner)
      .filter((key) => key !== "RUNNER_PUBLIC_URL")
      .sort(),
  );
});

function readGroups(source) {
  const startMarker = "const groups = ";
  const start = source.indexOf(startMarker);
  const end = source.indexOf("\n\n// Vercel projects", start);
  assert.notEqual(start, -1, "preflight groups declaration is missing");
  assert.notEqual(end, -1, "preflight groups terminator is missing");

  const objectSource = source.slice(start + startMarker.length, end).replace(/;\s*$/u, "");
  return vm.runInNewContext(`(${objectSource})`);
}

function assertIncludes(actual, expected) {
  for (const key of expected) assert.ok(actual.includes(key), `${key} should be in the preflight`);
}

function assertExcludes(actual, expected) {
  for (const key of expected) assert.ok(!actual.includes(key), `${key} should not be in the group`);
}

function readWorkflowWebRequired(workflow) {
  const stepStart = workflow.indexOf("- name: Check Vercel web env");
  const stepEnd = workflow.indexOf("- name: Pull Vercel web production env", stepStart);
  assert.notEqual(stepStart, -1, "web env workflow step is missing");
  assert.notEqual(stepEnd, -1, "web env workflow step terminator is missing");

  const arraySource = workflow
    .slice(stepStart, stepEnd)
    .match(/const required = (?<keys>\[[\s\S]*?\n\s*\]);/u)?.groups?.keys;
  assert.ok(arraySource, "web workflow required keys are missing");
  return [...vm.runInNewContext(arraySource)];
}

function readRenderKeys(render, serviceName) {
  const serviceStart = render.indexOf(`name: ${serviceName}`);
  const nextService = render.indexOf("\n  - type:", serviceStart);
  assert.notEqual(serviceStart, -1, `${serviceName} is missing from render.yaml`);
  const service = render.slice(serviceStart, nextService === -1 ? undefined : nextService);
  return [...service.matchAll(/^\s+- key: (?<key>[A-Z][A-Z0-9_]*)$/gmu)].map(
    (match) => match.groups.key,
  );
}

function groupKeys(group) {
  return [
    ...new Set([
      ...group.required,
      ...group.optional,
      ...(group.conditional ?? []).flatMap((rule) => [rule.when, ...rule.require]),
    ]),
  ];
}
