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
 * and machine reboots. Insecure mode serves shapes without an ELECTRIC_SECRET —
 * safe because the container binds to localhost behind the same-origin auth proxy.
 */
export function dockerRunArgs(databaseUrl, { detached = false } = {}) {
  return [
    "run",
    ...(detached ? ["-d", "--restart", "unless-stopped"] : ["--rm", "-it"]),
    "--name",
    ELECTRIC_CONTAINER,
    "-e",
    `DATABASE_URL=${databaseUrl}`,
    "-e",
    "ELECTRIC_INSECURE=true",
    "-p",
    `${ELECTRIC_PORT}:3000`,
    ELECTRIC_IMAGE,
  ];
}
