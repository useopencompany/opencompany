CREATE OR REPLACE FUNCTION "goat"."notify_brain_worker_admission_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  worker_kind text;
BEGIN
  IF TG_TABLE_NAME = 'brain_import_runs' THEN
    IF NEW.status IN ('discovering', 'ingesting', 'finalizing')
      AND NEW.next_run_at <= CURRENT_TIMESTAMP
      AND NEW.lease_id IS NULL THEN
      worker_kind := 'brain_import';
    END IF;
  ELSIF TG_TABLE_NAME = 'brain_ingest_jobs' THEN
    IF NEW.status = 'queued'
      AND NEW.plan_paused = false
      AND NEW.next_run_at <= CURRENT_TIMESTAMP
      AND NEW.lease_id IS NULL THEN
      worker_kind := 'brain_ingest';
    END IF;
  ELSIF TG_TABLE_NAME = 'google_drive_sync_cursors' THEN
    IF NEW.wake_requested_at IS NOT NULL THEN
      worker_kind := 'google_drive_sync';
    END IF;
  ELSIF TG_TABLE_NAME = 'brain_sources' THEN
    IF NEW.provider = 'google_drive' AND NEW.enabled = true THEN
      worker_kind := 'google_drive_sync';
    END IF;
  END IF;

  IF worker_kind IS NOT NULL THEN
    PERFORM pg_notify(
      'goat_brain_worker_admission_v1',
      json_build_object('worker', worker_kind)::text
    );
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "goat_brain_import_worker_admission_v1"
AFTER INSERT OR UPDATE OF "status", "next_run_at", "lease_id"
ON "goat"."brain_import_runs"
FOR EACH ROW
EXECUTE FUNCTION "goat"."notify_brain_worker_admission_v1"();--> statement-breakpoint

CREATE TRIGGER "goat_brain_ingest_worker_admission_v1"
AFTER INSERT OR UPDATE OF "status", "plan_paused", "next_run_at", "lease_id"
ON "goat"."brain_ingest_jobs"
FOR EACH ROW
EXECUTE FUNCTION "goat"."notify_brain_worker_admission_v1"();--> statement-breakpoint

CREATE TRIGGER "goat_google_drive_cursor_worker_admission_v1"
AFTER INSERT OR UPDATE OF "wake_requested_at"
ON "goat"."google_drive_sync_cursors"
FOR EACH ROW
EXECUTE FUNCTION "goat"."notify_brain_worker_admission_v1"();--> statement-breakpoint

CREATE TRIGGER "goat_google_drive_source_worker_admission_v1"
AFTER INSERT OR UPDATE OF "enabled", "config"
ON "goat"."brain_sources"
FOR EACH ROW
EXECUTE FUNCTION "goat"."notify_brain_worker_admission_v1"();
