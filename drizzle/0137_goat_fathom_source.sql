-- Fathom as a Goat Brain ingestion source: widen provider checks for the new
-- personal API-key integration and add the per-integration Fathom poll cursor
-- (the runner polls GET /external/v1/meetings with created_after/created_before
-- windows; the upper bound lags "now" so transcripts and summaries are ready).
ALTER TABLE "goat"."integrations" DROP CONSTRAINT IF EXISTS "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom'));--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT IF EXISTS "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom'));--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" DROP CONSTRAINT IF EXISTS "goat_integration_resources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("goat"."integration_resources"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'hubspot', 'granola', 'fathom'));--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" DROP CONSTRAINT IF EXISTS "goat_brain_sources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" ADD CONSTRAINT "goat_brain_sources_provider_check" CHECK ("goat"."brain_sources"."provider" IN ('jamie', 'gmail', 'google_drive', 'github', 'slack', 'linear', 'slack_bot', 'hubspot', 'granola', 'fathom'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_provider_check" CHECK ("goat"."brain_source_items"."source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'hubspot', 'granola', 'fathom'));--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_source_provider_check" CHECK ("goat"."brain_ingest_jobs"."source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'hubspot', 'granola', 'fathom'));--> statement-breakpoint
ALTER TABLE "goat"."workspace_ingestion_reservations" DROP CONSTRAINT IF EXISTS "goat_ingestion_reservations_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."workspace_ingestion_reservations" ADD CONSTRAINT "goat_ingestion_reservations_source_provider_check" CHECK ("goat"."workspace_ingestion_reservations"."source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'hubspot', 'granola', 'fathom'));--> statement-breakpoint
ALTER TABLE "goat"."brain_import_candidates" DROP CONSTRAINT IF EXISTS "goat_brain_import_candidates_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_import_candidates" ADD CONSTRAINT "goat_brain_import_candidates_provider_check" CHECK ("goat"."brain_import_candidates"."provider" IN ('public_web', 'github', 'jamie', 'granola', 'fathom', 'gmail', 'slack', 'linear'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."fathom_sync_state" (
	"integration_id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"created_after_cursor" timestamp with time zone,
	"page_cursor" text,
	"pending_created_before_cursor" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "goat"."fathom_sync_state" ADD CONSTRAINT "goat_fathom_sync_state_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."fathom_sync_state" ADD CONSTRAINT "goat_fathom_sync_state_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
