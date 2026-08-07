import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as legacyBillingSchema from "./legacy-billing-schema";
import * as llmBrokerSchema from "./llm-broker-schema";
import * as goatSchema from "./schema";

const schema = { ...legacyBillingSchema, ...llmBrokerSchema, ...goatSchema };

// Pooled driver for long-lived services (the runner). Unlike the default
// `neon-http` client in `./client` — which issues one HTTPS request per query and
// has no interactive transactions — this keeps a small bounded pool of persistent
// sockets and exposes real `db.transaction(...)`. It must connect to Neon's direct
// (non-pooled) endpoint, not the `-pooler` host, so session-level features
// (interactive transactions, LISTEN/NOTIFY) are available. The Next.js app stays on
// `neon-http`; do not import this from serverless route code.

export type PooledDb = NodePgDatabase<typeof schema>;

export type CreatePooledDbOptions = {
  /** Max connections in the pool. Size to worker concurrency + headroom. Default 10. */
  max?: number;
  /** Close idle clients after this many ms. Default 30_000. */
  idleTimeoutMillis?: number;
  /** Fail a new connection attempt after this many ms. Default 10_000. */
  connectionTimeoutMillis?: number;
  /** Per-statement timeout (`statement_timeout`) in ms. Unset by default. */
  statementTimeoutMillis?: number;
};

export type PooledDbHandle = {
  db: PooledDb;
  pool: Pool;
  /** Drains the pool, waiting for checked-out clients to be released. */
  close: () => Promise<void>;
};

export function createPooledDb(
  databaseUrl = process.env.DATABASE_URL,
  options: CreatePooledDbOptions = {},
): PooledDbHandle {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database access.");
  }

  const { connectionString, ssl } = resolveSsl(databaseUrl);

  const pool = new Pool({
    connectionString,
    ssl,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    ...(options.statementTimeoutMillis
      ? { statement_timeout: options.statementTimeoutMillis }
      : {}),
  });

  const db = drizzle(pool, { schema });

  return { db, pool, close: () => pool.end() };
}

// Translate libpq `sslmode` into an explicit `pg` SSL config and drop it from the
// connection string. Recent `pg-connection-string` deprecates inferring SSL behavior
// from `sslmode` in the URL (it warns on every connection and is changing what
// `require` means); configuring `ssl` directly is stable and keeps the current
// "encrypt, don't verify" posture for Neon's `sslmode=require` URLs.
function resolveSsl(databaseUrl: string): { connectionString: string; ssl: PoolConfig["ssl"] } {
  const queryIndex = databaseUrl.indexOf("?");
  if (queryIndex === -1) {
    return { connectionString: databaseUrl, ssl: undefined };
  }

  const params = new URLSearchParams(databaseUrl.slice(queryIndex + 1));
  const sslmode = params.get("sslmode");
  params.delete("sslmode");
  const rest = params.toString();
  const connectionString = rest
    ? `${databaseUrl.slice(0, queryIndex)}?${rest}`
    : databaseUrl.slice(0, queryIndex);

  return { connectionString, ssl: sslForMode(sslmode) };
}

function sslForMode(mode: string | null): PoolConfig["ssl"] {
  switch (mode) {
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true };
    case "require":
    case "prefer":
      // libpq `require` encrypts without verifying the certificate chain.
      return { rejectUnauthorized: false };
    default:
      // No / `disable` / `allow`: let pg connect without TLS (local Postgres).
      return undefined;
  }
}
