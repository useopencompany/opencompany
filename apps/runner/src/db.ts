import { createPooledDb, type PooledDb, type PooledDbHandle } from "@opencompany/db/pool";

// Runner-owned database client. The runner is a long-lived process that streams for
// minutes and issues many queries per turn, so it uses the pooled `node-postgres`
// driver (persistent sockets + real `db.transaction(...)`) instead of the web app's
// per-request `neon-http` client. Keeping this choice in a runner-local module is
// deliberate: nothing here can leak the pooled driver back into web code.

const DEFAULT_POOL_MAX = 10;

let handle: PooledDbHandle | undefined;

function getHandle(): PooledDbHandle {
  if (!handle) {
    handle = createPooledDb(resolveRunnerDatabaseUrl(), { max: resolvePoolMax() });
  }
  return handle;
}

export function getDb(): PooledDb {
  return getHandle().db;
}

export async function closeDb(): Promise<void> {
  if (!handle) return;
  const current = handle;
  handle = undefined;
  await current.close();
}

// Validates the runner DB configuration without opening a connection, so a
// misconfigured URL or pool size fails fast at boot instead of on the first query.
export function assertRunnerDbConfig(): void {
  resolveRunnerDatabaseUrl();
  resolvePoolMax();
}

function resolveRunnerDatabaseUrl(): string {
  const explicit = process.env.RUNNER_DATABASE_URL?.trim();
  if (explicit) return explicit;

  const base = process.env.DATABASE_URL?.trim();
  if (!base) {
    throw new Error("RUNNER_DATABASE_URL or DATABASE_URL is required for the runner database.");
  }
  return toDirectEndpoint(base);
}

// Neon's pooled endpoint runs PgBouncer in transaction mode, which cannot do
// interactive transactions or LISTEN/NOTIFY. The runner needs the direct endpoint,
// whose host is the pooled host minus the `-pooler` label. Falling back to this
// derivation means a normal pooled `DATABASE_URL` works for the runner with no extra
// config; set `RUNNER_DATABASE_URL` explicitly to override.
export function toDirectEndpoint(databaseUrl: string): string {
  return databaseUrl.replace("-pooler.", ".");
}

function resolvePoolMax(): number {
  const raw = process.env.RUNNER_DB_POOL_MAX?.trim();
  if (!raw) return DEFAULT_POOL_MAX;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("RUNNER_DB_POOL_MAX must be a positive integer.");
  }
  return value;
}
