-- GitHub as a Goat Brain ingestion source: widen provider/type checks so GitHub
-- pull-request and issue activity flows through the shared source-item +
-- agent-ingest pipeline. No buffer table: unlike Slack messages, each GitHub
-- event is a complete artifact, so the webhook enqueues ingest jobs directly
-- (the Jamie pattern). Ordered after the Linear source migration (0110), so the
-- widened checks keep 'linear' alongside the added 'github'.
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_provider_check" CHECK ("goat"."brain_source_items"."source_provider" IN ('jamie', 'goat-chat', 'upload', 'slack', 'linear', 'github'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_type_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_type_check" CHECK ("goat"."brain_source_items"."source_type" IN ('meeting', 'capture', 'asset', 'conversation', 'issue', 'activity'));--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_source_provider_check" CHECK ("goat"."brain_ingest_jobs"."source_provider" IN ('jamie', 'goat-chat', 'upload', 'slack', 'linear', 'github'));
