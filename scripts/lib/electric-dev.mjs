// Shared config for the local Electric sync service. Used by both the
// foreground runner (scripts/electric-dev.mjs) and the setup orchestrator
// (scripts/setup.mjs), which starts Electric detached so `bun run setup`
// leaves a working dev environment in one go.

export const ELECTRIC_IMAGE = "electricsql/electric:latest";
export const ELECTRIC_CONTAINER =
  process.env.ELECTRIC_CONTAINER_NAME?.trim() || "opencompany-electric";
export const ELECTRIC_PORT = process.env.ELECTRIC_DEV_PORT?.trim() || "3010";
export const ELECTRIC_LOCAL_URL = `http://localhost:${ELECTRIC_PORT}`;
export const ELECTRIC_HEALTH_URL = `${ELECTRIC_LOCAL_URL}/v1/health`;

/**
 * The connection string Electric should sync from. Electric needs Neon's DIRECT
 * (non-pooled) endpoint for logical replication, so we strip the "-pooler" host
 * label — the same derivation the runner uses (apps/runner/src/db.ts). An
 * explicit ELECTRIC_DATABASE_URL is assumed to already be a direct URL.
 * Returns null when no real DATABASE_URL is set yet.
 */
export function directDatabaseUrl(env = process.env) {
  const explicit = env.ELECTRIC_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const pooled = env.DATABASE_URL?.trim();
  if (!pooled || pooled.startsWith("postgresql://...")) return null;
  return pooled.replace("-pooler.", ".");
}

/**
 * `docker run` args for Electric. Foreground (`--rm -it`) for the manual runner;
 * detached (`-d --restart unless-stopped`) for setup so it survives dev restarts
 * and machine reboots.
 *
 * Security mode: Electric is secure-by-default and its HTTP API is public unless an
 * ELECTRIC_SECRET is set. When `env.ELECTRIC_SECRET` is present we run secure — every
 * request must carry the `secret` query param, which the web auth proxy injects
 * server-side (apps/web/app/api/electric/v1/shape/route.ts). With no secret we run
 * insecure, which is safe for local dev only because the container binds to localhost
 * behind the same-origin proxy. Shared/preview deployments MUST set ELECTRIC_SECRET
 * (issue #351).
 *
 * Storage: when `env.ELECTRIC_STORAGE_DIR` is set we point Electric's on-disk shape
 * log at it. Electric's storage is NOT disposable — it must stay in sync with the
 * Postgres replication slot — so previews back this with a persistent volume.
 */
export function dockerRunArgs(databaseUrl, { detached = false, env = process.env } = {}) {
  const secret = env.ELECTRIC_SECRET?.trim();
  const storageDir = env.ELECTRIC_STORAGE_DIR?.trim();
  return [
    "run",
    ...(detached ? ["-d", "--restart", "unless-stopped"] : ["--rm", "-it"]),
    "--name",
    ELECTRIC_CONTAINER,
    "-e",
    `DATABASE_URL=${databaseUrl}`,
    ...(secret ? ["-e", `ELECTRIC_SECRET=${secret}`] : ["-e", "ELECTRIC_INSECURE=true"]),
    ...(storageDir ? ["-e", `ELECTRIC_STORAGE_DIR=${storageDir}`] : []),
    "-p",
    `${ELECTRIC_PORT}:3000`,
    ELECTRIC_IMAGE,
  ];
}
