#!/usr/bin/env node

// Runs before production migrations when Goat is in the release scope. It
// reads Vercel env values only to validate them and never prints them.

const requiredGoatKeys = ["GOAT_STRIPE_API_KEY", "GOAT_STRIPE_CHECKOUT_ENABLED", "CRON_SECRET"];

const goatProjectId = requiredProcessEnv("GOAT_VERCEL_PROJECT_ID");
const teamId = requiredProcessEnv("VERCEL_ORG_ID");
const token = requiredProcessEnv("VERCEL_TOKEN");

const goatEnv = await listProductionEnv(goatProjectId, "Goat");
const goatValues = await readRequiredValues(goatProjectId, goatEnv, requiredGoatKeys, "Goat");

const invalid = [];
if (!goatValues.GOAT_STRIPE_API_KEY.startsWith("rk_live_")) {
  invalid.push("Goat GOAT_STRIPE_API_KEY must be a live restricted Stripe key.");
}
if (goatValues.GOAT_STRIPE_CHECKOUT_ENABLED !== "true") {
  invalid.push(
    "Goat GOAT_STRIPE_CHECKOUT_ENABLED must be true before a production billing release.",
  );
}
if (goatValues.CRON_SECRET.length < 32) {
  invalid.push("Goat CRON_SECRET must be at least 32 characters.");
}
if (invalid.length > 0) {
  throw new Error(`Production Goat billing configuration is invalid:\n- ${invalid.join("\n- ")}`);
}

console.log("Verified production web billing and cron relay configuration.");

async function listProductionEnv(projectId, label) {
  const response = await fetch(
    `https://api.vercel.com/v10/projects/${projectId}/env?teamId=${teamId}&target=production`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(
      `Could not fetch ${label} Vercel env metadata: ${response.status} ${response.statusText}`,
    );
  }
  const { envs } = await response.json();
  return envs.filter(
    (env) => Array.isArray(env.target) && env.target.includes("production") && !env.gitBranch,
  );
}

async function readRequiredValues(projectId, envs, keys, label) {
  const entries = await Promise.all(
    keys.map(async (key) => [key, await readEnvValue(projectId, envs, key, label)]),
  );
  return Object.fromEntries(entries);
}

async function readEnvValue(projectId, envs, key, label) {
  const matches = envs.filter((env) => env.key === key);
  if (matches.length !== 1) {
    throw new Error(`${label} must have exactly one production ${key}; found ${matches.length}.`);
  }
  const response = await fetch(
    `https://api.vercel.com/v1/projects/${projectId}/env/${matches[0].id}?teamId=${teamId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(`Could not read ${label} ${key}: ${response.status} ${response.statusText}`);
  }
  const env = await response.json();
  if (env.decrypted !== true || typeof env.value !== "string" || env.value.trim() === "") {
    throw new Error(`${label} ${key} is empty or could not be decrypted.`);
  }
  return env.value.trim();
}

function requiredProcessEnv(key) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required to verify production Goat billing.`);
  return value;
}
