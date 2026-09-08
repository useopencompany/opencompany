UPDATE goat.brain_import_runs AS run
SET status = 'canceled',
    lease_id = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error = NULL,
    completed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
FROM goat.brains AS brain
JOIN goat.workspaces AS workspace ON workspace.id = brain.workspace_id
WHERE run.brain_ref = brain.id
  AND workspace.legacy_brain_enabled = false
  AND run.status IN ('discovering', 'awaiting_confirmation', 'ingesting', 'finalizing');
--> statement-breakpoint
WITH canceled_jobs AS MATERIALIZED (
  UPDATE goat.brain_ingest_jobs AS job
  SET status = 'skipped',
      plan_paused = false,
      lease_id = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = NULL,
      result = job.result || jsonb_build_object(
        'skipped', true,
        'reason', 'legacy_brain_disabled',
        'summary', 'Stopped because legacy Brain is disabled for this workspace.'
      ),
      completed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE job.status IN ('queued', 'running')
    AND (
      EXISTS (
        SELECT 1
        FROM goat.workspaces AS workspace
        WHERE workspace.id = job.workspace_id
          AND workspace.legacy_brain_enabled = false
      )
      OR EXISTS (
        SELECT 1
        FROM goat.brains AS brain
        JOIN goat.workspaces AS workspace ON workspace.id = brain.workspace_id
        WHERE brain.id = job.brain_ref
          AND workspace.legacy_brain_enabled = false
      )
    )
  RETURNING job.id, job.source_item_id
)
UPDATE goat.brain_source_items AS source
SET last_ingest_status = 'skipped',
    last_ingested_at = CURRENT_TIMESTAMP,
    last_ingest_error = 'Stopped because legacy Brain is disabled for this workspace.',
    updated_at = CURRENT_TIMESTAMP
FROM canceled_jobs AS job
WHERE source.id = job.source_item_id
  AND source.last_ingest_job_id = job.id
  AND NOT EXISTS (
    SELECT 1
    FROM goat.brain_ingest_jobs AS other
    WHERE other.source_item_id = source.id
      AND other.id <> job.id
      AND other.status IN ('queued', 'running')
  );
--> statement-breakpoint
DELETE FROM goat.workspace_ingestion_reservations AS reservation
USING goat.workspaces AS workspace
WHERE reservation.workspace_id = workspace.id
  AND reservation.source_item_id IS NOT NULL
  AND reservation.status = 'pending'
  AND workspace.legacy_brain_enabled = false;
--> statement-breakpoint
UPDATE goat.brain_sources AS source
SET enabled = false,
    updated_at = CURRENT_TIMESTAMP
FROM goat.brains AS brain
JOIN goat.workspaces AS workspace ON workspace.id = brain.workspace_id
WHERE source.brain_id = brain.id
  AND source.enabled = true
  AND workspace.legacy_brain_enabled = false;
