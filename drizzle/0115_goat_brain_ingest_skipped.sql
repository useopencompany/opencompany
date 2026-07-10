ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_last_ingest_status_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_last_ingest_status_check" CHECK ("goat"."brain_source_items"."last_ingest_status" IS NULL OR "goat"."brain_source_items"."last_ingest_status" IN ('pending', 'succeeded', 'failed', 'skipped'));--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_status_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_status_check" CHECK ("goat"."brain_ingest_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'skipped'));
