-- Granola as a Goat Brain ingestion source: widen provider checks for the new
-- personal API-key integration, allow the api_key credential kind, and add the
-- per-integration Granola poll cursor (Granola has no webhooks; the runner
-- polls GET /v1/notes with updated_after).
ALTER TABLE "goat"."integrations" DROP CONSTRAINT IF EXISTS "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT IF EXISTS "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT IF EXISTS "goat_integration_credentials_kind_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_kind_check" CHECK ("goat"."integration_credentials"."kind" IN ('oauth_token', 'webhook_secret', 'api_key'));--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" DROP CONSTRAINT IF EXISTS "goat_integration_resources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("goat"."integration_resources"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" DROP CONSTRAINT IF EXISTS "goat_brain_sources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" ADD CONSTRAINT "goat_brain_sources_provider_check" CHECK ("goat"."brain_sources"."provider" IN ('jamie', 'gmail', 'google_drive', 'github', 'slack', 'linear', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_provider_check" CHECK ("goat"."brain_source_items"."source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_source_provider_check" CHECK ("goat"."brain_ingest_jobs"."source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."workspace_ingestion_reservations" DROP CONSTRAINT IF EXISTS "goat_ingestion_reservations_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."workspace_ingestion_reservations" ADD CONSTRAINT "goat_ingestion_reservations_source_provider_check" CHECK ("goat"."workspace_ingestion_reservations"."source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."brain_import_candidates" DROP CONSTRAINT IF EXISTS "goat_brain_import_candidates_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_import_candidates" ADD CONSTRAINT "goat_brain_import_candidates_provider_check" CHECK ("goat"."brain_import_candidates"."provider" IN ('public_web', 'github', 'jamie', 'granola', 'gmail', 'slack', 'linear'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."granola_sync_state" (
	"integration_id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"updated_after_cursor" timestamp with time zone,
	"page_cursor" text,
	"pending_updated_after_cursor" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "goat"."granola_sync_state" ADD CONSTRAINT "goat_granola_sync_state_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."granola_sync_state" ADD CONSTRAINT "goat_granola_sync_state_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
