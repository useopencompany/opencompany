-- HubSpot as a Goat Brain ingestion source: widen provider checks and add the
-- raw CRM-activity buffer the HubSpot webhook writes into (flushed per object
-- into object-window source items by the runner after a quiet period).
ALTER TABLE "goat"."integrations" DROP CONSTRAINT IF EXISTS "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'hubspot', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT IF EXISTS "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'hubspot', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" DROP CONSTRAINT IF EXISTS "goat_integration_resources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("goat"."integration_resources"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'hubspot', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" DROP CONSTRAINT IF EXISTS "goat_brain_sources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" ADD CONSTRAINT "goat_brain_sources_provider_check" CHECK ("goat"."brain_sources"."provider" IN ('jamie', 'gmail', 'google_drive', 'github', 'slack', 'linear', 'hubspot', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_provider_check" CHECK ("goat"."brain_source_items"."source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'hubspot', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_source_provider_check" CHECK ("goat"."brain_ingest_jobs"."source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'hubspot', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."workspace_ingestion_reservations" DROP CONSTRAINT IF EXISTS "goat_ingestion_reservations_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."workspace_ingestion_reservations" ADD CONSTRAINT "goat_ingestion_reservations_source_provider_check" CHECK ("goat"."workspace_ingestion_reservations"."source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'hubspot', 'granola'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."hubspot_object_events" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"portal_id" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"action" text NOT NULL,
	"property_name" text,
	"payload" jsonb NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_hubspot_object_events_object_type_check" CHECK ("goat"."hubspot_object_events"."object_type" IN ('contact', 'company', 'deal')),
	CONSTRAINT "goat_hubspot_object_events_action_check" CHECK ("goat"."hubspot_object_events"."action" IN ('create', 'update'))
);--> statement-breakpoint
ALTER TABLE "goat"."hubspot_object_events" ADD CONSTRAINT "goat_hubspot_object_events_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."hubspot_object_events" ADD CONSTRAINT "goat_hubspot_object_events_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."hubspot_object_events" ADD CONSTRAINT "goat_hubspot_object_events_source_item_id_brain_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "goat"."brain_source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_hubspot_object_events_integration_delivery_idx" ON "goat"."hubspot_object_events" ("integration_id", "delivery_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_hubspot_object_events_pending_idx" ON "goat"."hubspot_object_events" ("integration_id", "object_type", "object_id", "received_at") WHERE "goat"."hubspot_object_events"."source_item_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_hubspot_object_events_source_item_idx" ON "goat"."hubspot_object_events" ("source_item_id");
