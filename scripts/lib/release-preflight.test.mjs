import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { renderSurfaceConfig } from "./release-orchestration.mjs";
import { surfaceConfig } from "./release-vercel.mjs";

const preflightUrl = new URL("../release-preflight.mjs", import.meta.url);
const renderUrl = new URL("../../render.yaml", import.meta.url);

test("production preflight follows the deployed runtime boundaries", async () => {
  const [source, render] = await Promise.all([
    readFile(preflightUrl, "utf8"),
    readFile(renderUrl, "utf8"),
  ]);
  const groups = readGroups(source);

  assertIncludes(groups.web.required, [
    "DATABASE_URL",
    "BLOB_READ_WRITE_TOKEN",
    "OPENCOMPANY_DESKTOP_AUTH_SECRET",
    "BETTER_STACK_ERRORS_DSN",
    "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN",
    "OBSERVABILITY_ENABLED",
    "OBSERVABILITY_ENV",
    "NEXT_PUBLIC_OBSERVABILITY_ENABLED",
    "NEXT_PUBLIC_OBSERVABILITY_ENV",
  ]);
  assertExcludes(
    [...groups.web.required, ...groups.web.optional],
    [
      "OPENCOMPANY_AUTHKIT_DOMAIN",
      "OPENCOMPANY_STRIPE_API_KEY",
      "OPENCOMPANY_STRIPE_CHECKOUT_ENABLED",
      "OPENCOMPANY_STRIPE_WEBHOOK_SECRET",
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
    "RUNNER_OPENCOMPANY_TASK_WORKER_ENABLED",
  ]);
  assertExcludes(
    [...groups.runner.required, ...groups.runner.optional],
    [
      "BROWSERBASE_API_KEY",
      "BROWSERBASE_PROJECT_ID",
      "OPENCOMPANY_BROWSER_PROFILES_ENABLED",
      "OPENCOMPANY_BROWSER_PROFILES_KILL_SWITCH",
    ],
  );
  assert.equal(groups.runner.conditional, undefined);

  for (const [name, group] of Object.entries(groups)) {
    const keys = [...group.required, ...group.optional];
    assert.equal(new Set(keys).size, keys.length, `${name} preflight keys must be unique`);
  }

  assert.deepEqual([...surfaceConfig("web").requiredEnv].sort(), [...groups.web.required].sort());
  assert.deepEqual(readRenderKeys(render, "opencompany-api").sort(), groupKeys(groups.api).sort());
  assert.deepEqual(
    readRenderKeys(render, "opencompany-runner").sort(),
    groupKeys(groups.runner)
      .filter((key) => key !== "RUNNER_PUBLIC_URL")
      .sort(),
  );
  assert.equal(
    readRenderShutdownDelay(render, "opencompany-api"),
    renderSurfaceConfig("api").maxShutdownDelaySeconds,
  );
  assert.equal(
    readRenderShutdownDelay(render, "opencompany-runner"),
    renderSurfaceConfig("runner").maxShutdownDelaySeconds,
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

function readRenderKeys(render, serviceName) {
  const serviceStart = render.indexOf(`name: ${serviceName}`);
  const nextService = render.indexOf("\n  - type:", serviceStart);
  assert.notEqual(serviceStart, -1, `${serviceName} is missing from render.yaml`);
  const service = render.slice(serviceStart, nextService === -1 ? undefined : nextService);
  return [...service.matchAll(/^\s+- key: (?<key>[A-Z][A-Z0-9_]*)$/gmu)].map(
    (match) => match.groups.key,
  );
}

function readRenderShutdownDelay(render, serviceName) {
  const serviceStart = render.indexOf(`name: ${serviceName}`);
  const nextService = render.indexOf("\n  - type:", serviceStart);
  assert.notEqual(serviceStart, -1, `${serviceName} is missing from render.yaml`);
  const service = render.slice(serviceStart, nextService === -1 ? undefined : nextService);
  const match = service.match(/^\s+maxShutdownDelaySeconds:\s+(\d+)$/mu);
  assert.ok(match, `${serviceName} is missing maxShutdownDelaySeconds`);
  return Number(match[1]);
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
