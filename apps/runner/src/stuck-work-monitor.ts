import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { createPollingWorker } from "./polling-worker";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "stuck-work-monitor" });
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_BACKGROUND_THRESHOLD_MS = 20 * 60_000;
const MAX_STUCK_ROWS = 100;

export type StuckRunnerWork = {
  kind: "codex_chat_turn" | "brain_ingest_job" | "brain_import_run";
  id: string;
  status: string;
  updatedAt: Date;
};

export async function listStuckRunnerWork(input: {
  now?: Date;
  turnThresholdMs: number;
  backgroundThresholdMs?: number;
}) {
  const now = input.now ?? new Date();
  const turnCutoff = new Date(now.getTime() - input.turnThresholdMs);
  const backgroundCutoff = new Date(
    now.getTime() - (input.backgroundThresholdMs ?? DEFAULT_BACKGROUND_THRESHOLD_MS),
  );
  const result = await getDb().execute(sql`
    SELECT kind, id, status, updated_at AS "updatedAt"
    FROM (
      SELECT
        'codex_chat_turn'::text AS kind,
        turn.id,
        turn.status,
        CASE
          WHEN turn.status = 'running'
            THEN COALESCE(attempt.started_at, turn.updated_at)
          ELSE turn.updated_at
        END AS updated_at
      FROM goat.codex_chat_turns AS turn
      LEFT JOIN goat.run_attempts AS attempt
        ON attempt.run_id = turn.id
       AND attempt.lease_id = turn.lease_id
      WHERE turn.status IN ('queued', 'running')
        AND (turn.run_after IS NULL OR turn.run_after <= ${now})
        AND NOT EXISTS (
          SELECT 1
          FROM goat.tasks AS task
          WHERE task.session_id = turn.chat_session_id
            AND task.status = 'waiting'
        )
        AND CASE
          WHEN turn.status = 'running'
            THEN COALESCE(attempt.started_at, turn.updated_at)
          ELSE turn.updated_at
        END <= ${turnCutoff}

      UNION ALL

      SELECT
        'brain_ingest_job'::text AS kind,
        job.id,
        job.status,
        job.next_run_at AS updated_at
      FROM goat.brain_ingest_jobs AS job
      WHERE job.status IN ('queued', 'running')
        AND job.plan_paused = false
        AND job.next_run_at <= ${backgroundCutoff}

      UNION ALL

      SELECT
        'brain_import_run'::text AS kind,
        import_run.id,
        import_run.status,
        import_run.next_run_at AS updated_at
      FROM goat.brain_import_runs AS import_run
      WHERE import_run.status IN ('discovering', 'ingesting', 'finalizing')
        AND import_run.next_run_at <= ${backgroundCutoff}
    ) AS stuck
    ORDER BY updated_at ASC, kind ASC, id ASC
    LIMIT ${MAX_STUCK_ROWS}
  `);
  return rowsFromExecute<StuckRunnerWork>(result).map((row) => ({
    ...row,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt),
  }));
}

export function createStuckWorkReporter(
  report: (work: StuckRunnerWork[]) => void = reportStuckWork,
) {
  let reported = new Set<string>();
  return (work: StuckRunnerWork[]) => {
    const keys = new Set(work.map(stuckWorkKey));
    const newlyStuck = work.filter((item) => !reported.has(stuckWorkKey(item)));
    reported = keys;
    if (newlyStuck.length > 0) report(newlyStuck);
  };
}

export function startStuckWorkMonitor(options: {
  turnThresholdMs: number;
  backgroundThresholdMs?: number;
  pollIntervalMs?: number;
}) {
  const report = createStuckWorkReporter();
  return createPollingWorker({
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    poll: async ({ signal }) => {
      signal.throwIfAborted();
      report(
        await listStuckRunnerWork({
          turnThresholdMs: options.turnThresholdMs,
          ...(options.backgroundThresholdMs
            ? { backgroundThresholdMs: options.backgroundThresholdMs }
            : {}),
        }),
      );
    },
    onError: (error) => {
      captureException(error, { event: "opencompany.runner_stuck_work_monitor_failed" });
      logger.error("Runner stuck-work monitor failed", {
        event: "opencompany.runner_stuck_work_monitor_failed",
        error,
      });
    },
  });
}

function reportStuckWork(work: StuckRunnerWork[]) {
  const error = new Error(`Runner detected ${work.length} newly stuck turn(s) or job(s).`);
  const fields = {
    event: "opencompany.runner_stuck_work_detected",
    stuck_count: work.length,
    stuck_kinds: [...new Set(work.map((item) => item.kind))],
    stuck_work: work.slice(0, 20).map((item) => ({
      kind: item.kind,
      id: item.id,
      status: item.status,
      updated_at: item.updatedAt.toISOString(),
    })),
  };
  captureException(error, fields);
  logger.error("Runner detected stuck turns or jobs", { ...fields, error });
}

function stuckWorkKey(work: StuckRunnerWork) {
  return `${work.kind}:${work.id}:${work.status}`;
}
