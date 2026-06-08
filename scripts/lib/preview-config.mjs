// Pure, dependency-free helpers shared by the preview provision/teardown scripts and
// the preview reaper. Everything here is deterministic from the PR number so the
// orchestrator and the reconciler agree on resource names without shared state, and
// teardown can find what provision created. Issue #351.

// Stable tag stamped on every preview resource so the reaper can enumerate "actual"
// state and never touch prod.
export const PREVIEW_TAG = "opencompany-preview";

/**
 * All deterministic names/identifiers for a PR's preview stack. Derivable by anyone
 * who knows the PR number — no manifest required for discovery (the manifest records
 * the platform-assigned IDs, not these names).
 */
export function previewNames(prNumber, { baseDomain } = {}) {
  const pr = assertPrNumber(prNumber);
  return {
    pr,
    // Neon supports "/" in branch names; this matches the design's preview/pr-N scheme.
    neonBranch: `preview/pr-${pr}`,
    runnerService: `oc-preview-pr-${pr}-runner`,
    electricService: `oc-preview-pr-${pr}-electric`,
    streamsService: `oc-preview-pr-${pr}-streams`,
    prTag: `pr-${pr}`,
    alias: baseDomain ? `pr-${pr}.${stripDomain(baseDomain)}` : undefined,
    aliasUrl: baseDomain ? `https://pr-${pr}.${stripDomain(baseDomain)}` : undefined,
    redirectUri: baseDomain
      ? `https://pr-${pr}.${stripDomain(baseDomain)}/auth/callback`
      : undefined,
  };
}

/**
 * Derive Neon's DIRECT (non-pooled) connection string from the pooled one by stripping
 * the "-pooler" host label — the same derivation the runner and Electric dev use. Electric
 * and the runner's pooled pg driver both need the direct endpoint for logical replication
 * / interactive transactions.
 */
export function toDirectConnectionString(pooledUrl) {
  if (typeof pooledUrl !== "string" || !pooledUrl) {
    throw new Error("toDirectConnectionString requires a connection string.");
  }
  return pooledUrl.replace("-pooler.", ".");
}

/**
 * The environment a per-PR Vercel WEB deploy needs, pointing every cross-service var at
 * this PR's isolated stack. NEXT_PUBLIC_* are build-time and must be present before
 * `vercel build`. Base/static secrets (WorkOS, GitHub App, etc.) come from the Infisical
 * `dev` sync on the Vercel Preview environment; only the dynamic per-PR values are here.
 */
export function webDeployEnv({
  pr,
  sha,
  databaseUrl,
  runnerUrl,
  runnerInternalToken,
  electricUrl,
  electricSecret,
  streamsUrl,
  streamsToken,
  redirectUri,
}) {
  return compact({
    DATABASE_URL: databaseUrl,
    RUNNER_INTERNAL_URL: runnerUrl,
    RUNNER_PUBLIC_URL: runnerUrl,
    RUNNER_INTERNAL_TOKEN: runnerInternalToken,
    ELECTRIC_URL: electricUrl,
    ELECTRIC_SECRET: electricSecret,
    DURABLE_STREAMS_URL: streamsUrl,
    DURABLE_STREAMS_TOKEN: streamsToken,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: redirectUri,
    OBSERVABILITY_ENV: "preview",
    OBSERVABILITY_RELEASE: sha,
    NEXT_PUBLIC_OBSERVABILITY_RELEASE: sha,
    PREVIEW_PR_NUMBER: pr === undefined ? undefined : String(pr),
  });
}

/**
 * The environment the per-PR RUNNER service needs. Carries the preview-identity trio
 * (PREVIEW_ENV + NEON_BRANCH_ID + PREVIEW_PR_NUMBER) consumed by the boot-time safety
 * gate (apps/runner/src/preview-guard.ts), plus the Neon API creds it needs to verify
 * the endpoint→branch mapping. Uses the DIRECT endpoint (pooled can't do interactive
 * transactions / LISTEN-NOTIFY).
 */
export function runnerServiceEnv({
  pr,
  directDatabaseUrl,
  neonBranchId,
  neonProjectId,
  neonApiKey,
  runnerInternalToken,
  streamsUrl,
  streamsToken,
  allowedOrigins,
  workerConcurrency = "2",
  dbPoolMax = "5",
}) {
  return compact({
    PREVIEW_ENV: "true",
    PREVIEW_PR_NUMBER: pr === undefined ? undefined : String(pr),
    NEON_BRANCH_ID: neonBranchId,
    NEON_PROJECT_ID: neonProjectId,
    NEON_API_KEY: neonApiKey,
    DATABASE_URL: directDatabaseUrl,
    RUNNER_DATABASE_URL: directDatabaseUrl,
    RUNNER_INTERNAL_TOKEN: runnerInternalToken,
    RUNNER_ALLOWED_ORIGINS: allowedOrigins,
    RUNNER_WORKER_CONCURRENCY: workerConcurrency,
    RUNNER_DB_POOL_MAX: dbPoolMax,
    DURABLE_STREAMS_URL: streamsUrl,
    DURABLE_STREAMS_TOKEN: streamsToken,
    OBSERVABILITY_ENV: "preview",
  });
}

/**
 * The environment the per-PR ELECTRIC service needs. Direct endpoint for replication;
 * ELECTRIC_SECRET puts Electric in secure mode (its HTTP API is public by default), and
 * the web proxy injects the same secret. Storage mode is configurable (issue #351 §4.4 —
 * Electric's on-disk shape log must stay in sync with the replication slot).
 */
export function electricServiceEnv({ directDatabaseUrl, electricSecret, storageDir }) {
  return compact({
    DATABASE_URL: directDatabaseUrl,
    ELECTRIC_SECRET: electricSecret,
    ELECTRIC_STORAGE_DIR: storageDir,
  });
}

/** Build the preview manifest recorded as the GitHub Deployment payload (source of truth for teardown). */
export function buildManifest({
  pr,
  sha,
  createdAt,
  neonBranchId,
  neonBranchName,
  runnerServiceId,
  runnerUrl,
  electricServiceId,
  electricUrl,
  streamsServiceId,
  streamsUrl,
  vercelDeploymentId,
  alias,
  ttlHours,
}) {
  return compact({
    schema: 1,
    tag: PREVIEW_TAG,
    pr: assertPrNumber(pr),
    sha,
    createdAt,
    neonBranchId,
    neonBranchName,
    runnerServiceId,
    runnerUrl,
    electricServiceId,
    electricUrl,
    streamsServiceId,
    streamsUrl,
    vercelDeploymentId,
    alias,
    ttlHours,
  });
}

/** True when a created-at + ttlHours has elapsed relative to `now` (ms epoch). */
export function isExpired(createdAtIso, ttlHours, now) {
  if (!ttlHours || ttlHours <= 0) return false;
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) return false;
  return now - created > ttlHours * 60 * 60 * 1000;
}

function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function stripDomain(domain) {
  return String(domain)
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function assertPrNumber(prNumber) {
  const pr = Number(prNumber);
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }
  return pr;
}
