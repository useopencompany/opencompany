import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const WEB_REQUIRED_ENV = [
  "DATABASE_URL",
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "WORKOS_COOKIE_PASSWORD",
  "WORKOS_COOKIE_DOMAIN",
  "OPENCOMPANY_DESKTOP_AUTH_SECRET",
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
  "BETTER_STACK_ERRORS_DSN",
  "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN",
  "OBSERVABILITY_ENABLED",
  "OBSERVABILITY_ENV",
  "NEXT_PUBLIC_OBSERVABILITY_ENABLED",
  "NEXT_PUBLIC_OBSERVABILITY_ENV",
  "OPENCOMPANY_OBSERVABILITY_ENABLED",
  "OPENCOMPANY_OTEL_EXPORTER_OTLP_ENDPOINT",
  "OPENCOMPANY_OTEL_EXPORTER_OTLP_HEADERS",
];
const MARKETING_REQUIRED_ENV = [
  "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_TOKEN",
  "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_HOST",
];
const DOCS_REQUIRED_ENV = [];

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
  if (surface === "docs") {
    return {
      projectEnv: "DOCS_VERCEL_PROJECT_ID",
      rootDirectory: "apps/docs",
      requiredEnv: DOCS_REQUIRED_ENV,
      minimumSkewProtectionMaxAge: 0,
    };
  }
  throw new Error(`Unknown Vercel surface: ${surface}`);
}

export function validateProject(
  surface,
  project,
  { projectId, webProjectId = "", marketingProjectId = "", docsProjectId = "" },
) {
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
  const projectIdsBySurface = {
    web: webProjectId,
    marketing: marketingProjectId,
    docs: docsProjectId,
  };
  const reusedBy = Object.entries(projectIdsBySurface).find(
    ([candidateSurface, candidateProjectId]) =>
      candidateSurface !== surface && candidateProjectId === projectId,
  );
  if (reusedBy) {
    throw new Error(`${surface} must use a separate Vercel project from ${reusedBy[0]}.`);
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

export async function verifyOtlpTraceExporter({ endpoint, serializedHeaders, fetchImpl = fetch }) {
  const url = otlpSignalEndpoint(endpoint, "traces");
  const headers = parseOtlpHeaders(serializedHeaders);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ resourceSpans: [] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `OpenTelemetry trace exporter authentication probe failed: ${response.status} ${response.statusText}.`,
    );
  }
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

export function vercelCurlArgs(path, deploymentUrl) {
  // Vercel CLI 54.5 forwards global auth/scope flags to the underlying curl process. A full
  // deployment URL lets the CLI resolve the owning team while authentication stays in VERCEL_TOKEN.
  const target = new URL(path, `${deploymentUrl.replace(/\/+$/, "")}/`).toString();
  return ["vercel", "curl", target, "--yes"];
}

export function vercelDeployArgs({ token, teamId, projectId }) {
  return [
    "vercel",
    "deploy",
    "--prebuilt",
    "--archive=tgz",
    "--prod",
    "--no-wait",
    "--skip-domain",
    "--yes",
    "--format",
    "json",
    "--token",
    token,
    "--scope",
    teamId,
    "--project",
    projectId,
  ];
}

function parseOtlpHeaders(value) {
  const headers = {};
  for (const item of value.split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    const headerValue = item.slice(separator + 1).trim();
    if (key && headerValue) headers[key] = headerValue;
  }
  return headers;
}

function otlpSignalEndpoint(endpoint, signal) {
  const normalized = endpoint.trim().replace(/\/+$/u, "");
  const url = new URL(
    normalized.endsWith(`/v1/${signal}`) ? normalized : `${normalized}/v1/${signal}`,
  );
  if (url.protocol !== "https:") {
    throw new Error("The production OpenTelemetry exporter endpoint must use HTTPS.");
  }
  return url;
}

function copyDirectoryContents(source, destination) {
  for (const entry of readdirSync(source)) {
    cpSync(`${source}/${entry}`, `${destination}/${entry}`, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
  }
}
