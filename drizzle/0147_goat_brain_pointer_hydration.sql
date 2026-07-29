ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_type_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_type_check" CHECK ("goat"."brain_source_items"."source_type" IN ('meeting', 'run', 'capture', 'pointer', 'asset', 'conversation', 'issue', 'activity', 'thread', 'document'));--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_kind_check" CHECK ("goat"."brain_ingest_jobs"."kind" IN ('brain_source_item_ingest', 'brain_agent_ingest', 'brain_pointer_hydrate'));
