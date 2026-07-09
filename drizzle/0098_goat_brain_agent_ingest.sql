-- Goat Brain Step 2: agentic ingestion jobs.
-- New `brain_agent_ingest` job kind runs an agentic tool loop instead of the
-- deterministic template writer, and jobs carry the target brain (`brain_ref`)
-- so the agent operates strictly within one brain. Null brain_ref means the
-- handler resolves the user's default brain at run time.
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_kind_check";
--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_kind_check" CHECK ("goat"."brain_ingest_jobs"."kind" IN ('brain_source_item_ingest', 'brain_agent_ingest'));
--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD COLUMN IF NOT EXISTS "brain_ref" text;
--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE set null ON UPDATE no action;
