import { getDb } from "@opencompany/db";
import { sql } from "drizzle-orm";

type Db = ReturnType<typeof getDb>;
type BatchItem = Parameters<Db["batch"]>[0][number];

/**
 * The Neon HTTP driver this app uses does not support interactive transactions
 * (`db.transaction(tx => …)` throws "No transactions support in neon-http driver").
 * It does support `db.batch([...])`, which runs every statement inside a single
 * Postgres transaction over one HTTP round-trip.
 *
 * ElectricSQL reconciles optimistic writes by matching the transaction id (`xid`)
 * of the write against the `xid` it observes in the logical-replication stream.
 * To get a usable id we run the mutation(s) and `pg_current_xact_id()` in the SAME
 * batch so they share one transaction — the returned `txid` is what the client
 * passes to `collection.utils.awaitTxId(...)`.
 *
 * `pg_current_xact_id()` only assigns a real (non-virtual) xid once the
 * transaction has written, so the mutation statements must come first.
 *
 * @example
 *   const txid = await batchWithTxid(
 *     db.update(agents).set({ name }).where(eq(agents.id, id)),
 *   );
 *   return { ok: true, txid };
 */
export async function batchWithTxid(...statements: BatchItem[]): Promise<number> {
  if (statements.length === 0) {
    throw new Error("batchWithTxid requires at least one write statement.");
  }
  const db = getDb();
  const txidStatement = db.execute<{ txid: string }>(
    sql`SELECT pg_current_xact_id()::xid::text AS txid`,
  ) as unknown as BatchItem;
  const batch = [...statements, txidStatement] as unknown as Parameters<Db["batch"]>[0];
  const results = await db.batch(batch);
  const last = results.at(-1) as { rows?: Array<{ txid?: string }> } | Array<{ txid?: string }>;
  const row = Array.isArray(last) ? last[0] : last?.rows?.[0];
  const txid = row?.txid;
  if (!txid) {
    throw new Error("Failed to read transaction id (pg_current_xact_id) from write batch.");
  }
  // `::xid` is the 32-bit transaction id (fits safely in a JS number). Electric's
  // awaitTxId matches against numeric txids from the replication stream.
  const numeric = Number(txid);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Unexpected non-numeric transaction id: ${txid}`);
  }
  return numeric;
}
