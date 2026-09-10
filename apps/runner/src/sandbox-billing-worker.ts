import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { Sandbox, SandboxNotFoundError } from "e2b";
import { getDb } from "./db";
import { createPollingWorker } from "./polling-worker";
import {
  type SandboxBillingDb,
  type SandboxBillingSnapshot,
  settleSandboxBilling,
} from "./sandbox-billing";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "sandbox-billing" });
const POLL_INTERVAL_MS = 60_000;
const BATCH_SIZE = 100;
type BillingDependencies = {
  db?: SandboxBillingDb;
  getInfo?: (sandboxId: string, signal?: AbortSignal) => Promise<SandboxBillingSnapshot>;
};

export async function billRegisteredSandbox(
  sandboxId: string,
  options: BillingDependencies & {
    signal?: AbortSignal;
    observedAt?: Date;
  } = {},
) {
  const db = options.db ?? getDb();
  const registered = await db.execute(sql`
    SELECT sandbox_id FROM goat.sandbox_billing_cursors WHERE sandbox_id = ${sandboxId}
  `);
  if (rowsFromExecute(registered).length === 0) return 0;
  // Use the request start, so provider latency cannot extend the billed interval.
  const observedAt = options.observedAt ?? new Date();
  let snapshot: SandboxBillingSnapshot;
  try {
    snapshot = await (options.getInfo ?? getSandboxInfo)(sandboxId, options.signal);
  } catch (error) {
    if (!(error instanceof SandboxNotFoundError)) throw error;
    // Never infer usage from the last timeout when the provider has lost the evidence.
    await db.execute(sql`
      UPDATE goat.sandbox_billing_cursors SET missing_at = ${observedAt}
      WHERE sandbox_id = ${sandboxId}
    `);
    return 0;
  }
  if (snapshot.sandboxId !== sandboxId) throw new Error("E2B returned a different sandbox.");
  return settleSandboxBilling({ snapshot, observedAt, db });
}

export async function billSandboxBeforeTransition(sandboxId: string) {
  try {
    await billRegisteredSandbox(sandboxId);
  } catch (error) {
    reportBillingError(error, sandboxId);
  }
}

export async function pollSandboxBilling(
  input: BillingDependencies & {
    namespace: string;
    signal: AbortSignal;
    now?: Date;
  },
) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  // Claim a bounded batch across replicas. A crashed poll becomes eligible again in
  // one minute; the financial cursor only moves inside the settlement transaction.
  const result = await db.execute(sql`
    WITH due AS (
      SELECT sandbox_id FROM goat.sandbox_billing_cursors
      WHERE namespace = ${input.namespace} AND missing_at IS NULL AND next_poll_at <= ${now}
      ORDER BY next_poll_at, sandbox_id
      LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    )
    UPDATE goat.sandbox_billing_cursors AS cursor
    SET next_poll_at = ${new Date(now.getTime() + POLL_INTERVAL_MS)}
    FROM due WHERE cursor.sandbox_id = due.sandbox_id
    RETURNING cursor.sandbox_id AS "sandboxId"
  `);
  const rows = rowsFromExecute<{ sandboxId: string }>(result);
  for (const row of rows) {
    input.signal.throwIfAborted();
    try {
      await billRegisteredSandbox(row.sandboxId, {
        db,
        signal: input.signal,
        observedAt: now,
        ...(input.getInfo ? { getInfo: input.getInfo } : {}),
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      reportBillingError(error, row.sandboxId);
    }
  }
  return rows.length === BATCH_SIZE;
}

export function startSandboxBillingWorker(namespace: string) {
  return createPollingWorker({
    pollIntervalMs: POLL_INTERVAL_MS,
    poll: ({ signal }) => pollSandboxBilling({ namespace, signal }),
    onError: (error) => reportBillingError(error),
  });
}

function getSandboxInfo(sandboxId: string, signal?: AbortSignal) {
  return Sandbox.getInfo(sandboxId, { requestTimeoutMs: 10_000, ...(signal ? { signal } : {}) });
}

function reportBillingError(error: unknown, sandboxId?: string) {
  captureException(error, { event: "opencompany.sandbox_billing_failed", sandbox_id: sandboxId });
  logger.error("E2B usage settlement failed; the billing cursor remains retryable", {
    event: "opencompany.sandbox_billing_failed",
    sandbox_id: sandboxId,
    error,
  });
}
