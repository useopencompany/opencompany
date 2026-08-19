import type { PooledDbClient, PooledDbHandle } from "@opencompany/db/pool";
import { createLogger } from "@opencompany/observability";
import { METRICS, recordCounter, recordGauge } from "@opencompany/telemetry";

type Pool = PooledDbHandle["pool"];

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "postgres-queue-maintenance",
});

export const EXECUTION_EVENT_RETENTION_DAYS = 30;
export const TERMINAL_TURN_RETENTION_DAYS = 90;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES_PER_TABLE = 20;
const MAINTENANCE_LOCK_NAME = "opencompany.postgres-queue-maintenance.v1";
const PRODUCT_DATABASE_NAMESPACE = "goat"; // Physical schema compatibility.
const AUTOVACUUM_DEAD_TUPLE_WARNING_MINIMUM = 1_000;
const AUTOVACUUM_DEAD_TUPLE_WARNING_RATIO = 0.2;

const PRUNE_QUERIES = {
  run_events: `
    WITH candidates AS MATERIALIZED (
      SELECT event.id
      FROM goat.run_events AS event
      INNER JOIN goat.codex_chat_turns AS turn ON turn.id = event.run_id
      WHERE event.created_at < $1
        AND turn.status IN ('completed', 'failed', 'interrupted')
        AND turn.completed_at IS NOT NULL
        AND turn.completed_at < $1
      ORDER BY event.created_at, event.id
      FOR UPDATE OF event SKIP LOCKED
      LIMIT $2
    ), deleted AS (
      DELETE FROM goat.run_events AS event
      USING candidates
      WHERE event.id = candidates.id
      RETURNING 1
    )
    SELECT count(*)::integer AS "deletedCount" FROM deleted
  `,
  codex_chat_events: `
    WITH candidates AS MATERIALIZED (
      SELECT event.id
      FROM goat.codex_chat_events AS event
      LEFT JOIN goat.codex_chat_turns AS turn ON turn.id = event.codex_chat_turn_id
      WHERE event.created_at < $1
        AND (
          event.codex_chat_turn_id IS NULL
          OR (
            turn.status IN ('completed', 'failed', 'interrupted')
            AND turn.completed_at IS NOT NULL
            AND turn.completed_at < $1
          )
        )
      ORDER BY event.created_at, event.id
      FOR UPDATE OF event SKIP LOCKED
      LIMIT $2
    ), deleted AS (
      DELETE FROM goat.codex_chat_events AS event
      USING candidates
      WHERE event.id = candidates.id
      RETURNING 1
    )
    SELECT count(*)::integer AS "deletedCount" FROM deleted
  `,
  task_events: `
    WITH candidates AS MATERIALIZED (
      SELECT event.id
      FROM goat.task_events AS event
      INNER JOIN goat.tasks AS task ON task.id = event.task_id
      WHERE event.created_at < $1
        AND task.status IN ('succeeded', 'failed', 'canceled')
        AND task.session_id IS NOT NULL
        AND task.updated_at < $1
      ORDER BY event.created_at, event.id
      FOR UPDATE OF event SKIP LOCKED
      LIMIT $2
    ), deleted AS (
      DELETE FROM goat.task_events AS event
      USING candidates
      WHERE event.id = candidates.id
      RETURNING 1
    )
    SELECT count(*)::integer AS "deletedCount" FROM deleted
  `,
  codex_chat_turns: `
    WITH candidates AS MATERIALIZED (
      SELECT turn.id
      FROM goat.codex_chat_turns AS turn
      WHERE turn.status IN ('completed', 'failed', 'interrupted')
        AND turn.completed_at IS NOT NULL
        AND turn.completed_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM goat.run_events AS event WHERE event.run_id = turn.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM goat.codex_chat_events AS event
          WHERE event.codex_chat_turn_id = turn.id
        )
      ORDER BY turn.completed_at, turn.id
      FOR UPDATE OF turn SKIP LOCKED
      LIMIT $2
    ), deleted AS (
      DELETE FROM goat.codex_chat_turns AS turn
      USING candidates
      WHERE turn.id = candidates.id
      RETURNING 1
    )
    SELECT count(*)::integer AS "deletedCount" FROM deleted
  `,
} as const;

type QueueTable = keyof typeof PRUNE_QUERIES;

export type QueueTableStats = {
  table: QueueTable;
  liveTuples: number;
  deadTuples: number;
  deadTupleRatio: number;
  lastAutovacuum: Date | null;
};

export type PostgresQueueMaintenanceResult = {
  acquired: boolean;
  pruned: Record<QueueTable, number>;
  tableStats: QueueTableStats[];
};

export async function runPostgresQueueMaintenance(input: {
  pool: Pool;
  now?: Date;
  batchSize?: number;
  maxBatchesPerTable?: number;
}): Promise<PostgresQueueMaintenanceResult> {
  const now = input.now ?? new Date();
  const batchSize = positiveInteger(input.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
  const maxBatchesPerTable = positiveInteger(
    input.maxBatchesPerTable ?? DEFAULT_MAX_BATCHES_PER_TABLE,
    "maxBatchesPerTable",
  );
  const eventCutoff = daysBefore(now, EXECUTION_EVENT_RETENTION_DAYS);
  const turnCutoff = daysBefore(now, TERMINAL_TURN_RETENTION_DAYS);
  const client = await input.pool.connect();
  let acquired = false;
  let operationError: unknown;
  let result: PostgresQueueMaintenanceResult | undefined;

  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [MAINTENANCE_LOCK_NAME],
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) {
      result = emptyResult(false);
    } else {
      const pruned = {
        run_events: await pruneBatches(
          client,
          PRUNE_QUERIES.run_events,
          eventCutoff,
          batchSize,
          maxBatchesPerTable,
        ),
        codex_chat_events: await pruneBatches(
          client,
          PRUNE_QUERIES.codex_chat_events,
          eventCutoff,
          batchSize,
          maxBatchesPerTable,
        ),
        task_events: await pruneBatches(
          client,
          PRUNE_QUERIES.task_events,
          eventCutoff,
          batchSize,
          maxBatchesPerTable,
        ),
        codex_chat_turns: await pruneBatches(
          client,
          PRUNE_QUERIES.codex_chat_turns,
          turnCutoff,
          batchSize,
          maxBatchesPerTable,
        ),
      };
      const tableStats = await loadQueueTableStats(client);
      result = { acquired: true, pruned, tableStats };
    }
  } catch (error) {
    operationError = error;
  }

  if (acquired && !operationError) {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        MAINTENANCE_LOCK_NAME,
      ]);
    } catch (error) {
      operationError = error;
    }
  }
  if (operationError) {
    client.release(true);
    throw operationError;
  }
  client.release();
  return result ?? emptyResult(false);
}

async function pruneBatches(
  client: PooledDbClient,
  query: string,
  cutoff: Date,
  batchSize: number,
  maxBatches: number,
) {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const deleted = await client.query<{ deletedCount: number | string }>(query, [
      cutoff,
      batchSize,
    ]);
    const count = Number(deleted.rows[0]?.deletedCount ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Postgres queue maintenance returned an invalid delete count.");
    }
    total += count;
    if (count < batchSize) break;
  }
  return total;
}

async function loadQueueTableStats(client: PooledDbClient): Promise<QueueTableStats[]> {
  const stats = await client.query<{
    table: QueueTable;
    liveTuples: number | string;
    deadTuples: number | string;
    lastAutovacuum: Date | string | null;
  }>(
    `
      SELECT
        relname AS "table",
        n_live_tup AS "liveTuples",
        n_dead_tup AS "deadTuples",
        last_autovacuum AS "lastAutovacuum"
      FROM pg_stat_user_tables
      WHERE schemaname = $1
        AND relname IN ('run_events', 'codex_chat_events', 'task_events', 'codex_chat_turns')
      ORDER BY relname
    `,
    [PRODUCT_DATABASE_NAMESPACE],
  );
  return stats.rows.map((row) => {
    const liveTuples = nonNegativeNumber(row.liveTuples);
    const deadTuples = nonNegativeNumber(row.deadTuples);
    return {
      table: row.table,
      liveTuples,
      deadTuples,
      deadTupleRatio: deadTuples / Math.max(1, liveTuples + deadTuples),
      lastAutovacuum: row.lastAutovacuum ? new Date(row.lastAutovacuum) : null,
    };
  });
}

export function reportPostgresQueueMaintenance(result: PostgresQueueMaintenanceResult) {
  for (const [table, count] of Object.entries(result.pruned)) {
    if (count > 0) {
      recordCounter(METRICS.postgresQueueRowsPruned, count, { "goat.table": table });
    }
  }
  for (const stats of result.tableStats) {
    const attributes = { "goat.table": stats.table };
    recordGauge(METRICS.postgresQueueDeadTuples, stats.deadTuples, attributes, "{tuple}");
    recordGauge(METRICS.postgresQueueDeadTupleRatio, stats.deadTupleRatio, attributes);
    if (
      stats.deadTuples >= AUTOVACUUM_DEAD_TUPLE_WARNING_MINIMUM &&
      stats.deadTupleRatio >= AUTOVACUUM_DEAD_TUPLE_WARNING_RATIO
    ) {
      logger.warn("Postgres queue table has elevated dead tuples", {
        event: "opencompany.postgres_queue_autovacuum_lagging",
        table: stats.table,
        live_tuples: stats.liveTuples,
        dead_tuples: stats.deadTuples,
        dead_tuple_ratio: stats.deadTupleRatio,
        last_autovacuum: stats.lastAutovacuum?.toISOString() ?? null,
      });
    }
  }
  logger.info("Postgres queue maintenance completed", {
    event: "opencompany.postgres_queue_maintenance_completed",
    pruned_run_events: result.pruned.run_events,
    pruned_codex_chat_events: result.pruned.codex_chat_events,
    pruned_task_events: result.pruned.task_events,
    pruned_codex_chat_turns: result.pruned.codex_chat_turns,
  });
}

function emptyResult(acquired: boolean): PostgresQueueMaintenanceResult {
  return {
    acquired,
    pruned: { run_events: 0, codex_chat_events: 0, task_events: 0, codex_chat_turns: 0 },
    tableStats: [],
  };
}

function daysBefore(now: Date, days: number) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeNumber(value: number | string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Postgres queue statistics contained an invalid tuple count.");
  }
  return parsed;
}
