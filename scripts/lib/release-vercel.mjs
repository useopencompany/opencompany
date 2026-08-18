import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const WEB_REQUIRED_ENV = [
  "DATABASE_URL",
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "WORKOS_COOKIE_PASSWORD",
  "WORKOS_COOKIE_DOMAIN",
  "OPENCOMPANY_NEXT_PUBLIC_APP_URL",
  "OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI",
  "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_TOKEN",
  "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_HOST",
  "RUNNER_PUBLIC_URL",
  "RUNNER_INTERNAL_TOKEN",
  "OPENCOMPANY_API_ORIGIN",
  "NEXT_PUBLIC_OPENCOMPANY_API_ORIGIN",
  "CRON_SECRET",
  "BLOB_READ_WRITE_TOKEN",
];
const MARKETING_REQUIRED_ENV = [
  "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_TOKEN",
  "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_HOST",
];

export function surfaceConfig(surface) {
  if (surface === "web") {
    return {
      projectEnv: "OPENCOMPANY_VERCEL_PROJECT_ID",
      rootDirectory: "apps/web",
      requiredEnv: WEB_REQUIRED_ENV,
      minimumSkewProtectionMaxAge: 7 * 24 * 60 * 60,
    };
  }
  if (surface === "marketing") {
    return {
      projectEnv: "MARKETING_VERCEL_PROJECT_ID",
      rootDirectory: "apps/marketing",
      requiredEnv: MARKETING_REQUIRED_ENV,
      minimumSkewProtectionMaxAge: 0,
    };
  }
  throw new Error(`Unknown Vercel surface: ${surface}`);
}

export function validateProject(surface, project, { projectId, webProjectId = "" }) {
  const config = surfaceConfig(surface);
  if (project?.id !== projectId) {
    throw new Error(`Fetched ${surface} Vercel project id does not match ${config.projectEnv}.`);
  }
  if (project.rootDirectory !== config.rootDirectory) {
    throw new Error(
      `${surface} Vercel project rootDirectory must be ${config.rootDirectory}, got ${
        project.rootDirectory ?? "<unset>"
      }.`,
    );
  }
  if (surface === "marketing" && projectId === webProjectId) {
    throw new Error("Marketing must use a separate Vercel project from web.");
  }
  if ((project.skewProtectionMaxAge ?? 0) < config.minimumSkewProtectionMaxAge) {
    throw new Error(
      `${surface} Vercel Skew Protection maximum age must be at least ${
        config.minimumSkewProtectionMaxAge
      } seconds.`,
    );
  }
}

export function productionEnvironmentEntries(envs) {
  return envs.filter(
    (env) => Array.isArray(env.target) && env.target.includes("production") && !env.gitBranch,
  );
}

export function missingProductionKeys(surface, envs) {
  const present = new Set(productionEnvironmentEntries(envs).map((env) => env.key));
  return surfaceConfig(surface).requiredEnv.filter((key) => !present.has(key));
}

export function cleanVercelWorkDirectory(directory = ".vercel") {
  mkdirSync(directory, { recursive: true });
  for (const entry of readdirSync(directory)) {
    if (entry === "project.json.example") continue;
    rmSync(`${directory}/${entry}`, { recursive: true, force: true });
  }
}

export function savePreparedVercelDirectory(destination, source = ".vercel") {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  copyDirectoryContents(source, destination);
}

export function restorePreparedVercelDirectory(source, destination = ".vercel") {
  cleanVercelWorkDirectory(destination);
  copyDirectoryContents(source, destination);
}

function copyDirectoryContents(source, destination) {
  for (const entry of readdirSync(source)) {
    cpSync(`${source}/${entry}`, `${destination}/${entry}`, { recursive: true, force: true });
  }
}
