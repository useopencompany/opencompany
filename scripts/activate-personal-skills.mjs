#!/usr/bin/env node

import pg from "pg";

import {
  assertPersonalSkillsAuthorization,
  PERSONAL_SKILLS_DRAIN_MS,
} from "./lib/personal-skills-rollout.mjs";

const local = process.argv.slice(2).includes("--local");
if (process.argv.length > (local ? 3 : 2)) {
  throw new Error("Usage: activate-personal-skills.mjs [--local]");
}

const databaseUrl = requiredEnv(local ? "DATABASE_URL" : "PRODUCTION_DATABASE_URL");
const current = await readRollout(databaseUrl);
if (current.personalEnabled) {
  console.log("Personal Skills and plugins are already active.");
  process.exit(0);
}

if (!local) {
  const services = productionServices();
  await assertServicesReady(services);
  console.log(
    `Waiting ${Math.ceil(PERSONAL_SKILLS_DRAIN_MS / 1000)} seconds for previous web, API, and runner revisions to drain.`,
  );
  await sleep(PERSONAL_SKILLS_DRAIN_MS);
  await assertServicesReady(services);
}

const release = local ? "local-setup" : requiredEnv("RELEASE_SHA");
await activateRollout(databaseUrl, release);
console.log(
  `Personal Skills and plugins activated for ${local ? "local development" : release.slice(0, 7)}.`,
);

async function readRollout(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT personal_enabled AS "personalEnabled" FROM goat.skill_scope_rollout WHERE id = 'personal_skills'
       UNION ALL
       SELECT personal_enabled AS "personalEnabled" FROM goat.plugin_ownership_rollout WHERE id = 'personal_plugins'`,
    );
    if (result.rowCount !== 2) throw new Error("Personal ownership rollout rows are missing.");
    return { personalEnabled: result.rows.every((row) => row.personalEnabled === true) };
  } finally {
    await client.end();
  }
}

async function activateRollout(connectionString, release) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE goat.skill_scope_rollout
       SET personal_enabled = true,
           activated_at = now(),
           activated_release = $1
       WHERE id = 'personal_skills' AND NOT personal_enabled`,
      [release],
    );
    if (result.rowCount === 0) {
      const current = await client.query(
        "SELECT personal_enabled FROM goat.skill_scope_rollout WHERE id = 'personal_skills'",
      );
      if (current.rows[0]?.personal_enabled !== true)
        throw new Error("Personal Skills and plugins rollout could not be activated.");
    }
    const plugins = await client.query(
      "UPDATE goat.plugin_ownership_rollout SET personal_enabled = true WHERE id = 'personal_plugins' RETURNING id",
    );
    if (plugins.rowCount !== 1) throw new Error("Personal plugin rollout row is missing.");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

function productionServices() {
  return [
    ["API", healthUrl(requiredEnv("PRODUCTION_API_URL"))],
    ["runner", healthUrl(requiredEnv("RUNNER_PUBLIC_URL"))],
    ["web", `${requiredEnv("PRODUCTION_OPENCOMPANY_URL").replace(/\/+$/u, "")}/api/healthz`],
  ];
}

async function assertServicesReady(services) {
  await Promise.all(
    services.map(async ([service, url]) => {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`${service} health check returned ${response.status}.`);
      assertPersonalSkillsAuthorization(service, await response.json());
    }),
  );
}

function healthUrl(value) {
  return `${value.replace(/\/+$/u, "")}/healthz`;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
