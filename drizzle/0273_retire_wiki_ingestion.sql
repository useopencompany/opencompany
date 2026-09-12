ALTER TABLE goat.workflows ADD COLUMN event_activated_at timestamptz;
--> statement-breakpoint
UPDATE goat.workflows SET event_activated_at = updated_at WHERE trigger = 'event' AND status = 'active';
--> statement-breakpoint
UPDATE goat.wiki_sources SET enabled = false, updated_at = CURRENT_TIMESTAMP WHERE enabled = true;
--> statement-breakpoint
UPDATE goat.wiki_ingest_jobs
SET status = 'skipped', lease_id = NULL, lease_owner = NULL, lease_expires_at = NULL,
    completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
    last_error = NULL, result = result || jsonb_build_object('skipped', true, 'reason', 'wiki_ingestion_retired')
WHERE status IN ('queued', 'running');
--> statement-breakpoint
UPDATE goat.brain_import_runs
SET status = 'canceled', lease_id = NULL, lease_owner = NULL, lease_expires_at = NULL,
    completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
    last_error = 'Wiki ingestion has been retired.'
WHERE workspace_id IS NOT NULL AND brain_ref IS NULL
  AND status IN ('discovering', 'awaiting_confirmation', 'ingesting', 'finalizing');
--> statement-breakpoint
ALTER TABLE goat.wiki_sources ALTER COLUMN enabled SET DEFAULT false;
--> statement-breakpoint
ALTER TABLE goat.wiki_sources ADD CONSTRAINT opencompany_wiki_sources_retired_check CHECK (enabled = false);
--> statement-breakpoint
ALTER TABLE goat.wiki_ingest_jobs ADD CONSTRAINT opencompany_wiki_ingest_jobs_retired_check CHECK (status NOT IN ('queued', 'running'));
