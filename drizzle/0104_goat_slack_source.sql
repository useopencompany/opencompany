-- Slack as a Goat Brain ingestion source: widen provider/type checks, add a
-- team_id routing index, and add the raw message buffer the events webhook
-- writes into (flushed per channel into conversation-window source items by
-- the runner after a quiet period).
ALTER TABLE "goat"."integrations" DROP CONSTRAINT IF EXISTS "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'linear', 'github', 'jamie', 'slack'));--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT IF EXISTS "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'linear', 'github', 'jamie', 'slack'));--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" DROP CONSTRAINT IF EXISTS "goat_integration_resources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("goat"."integration_resources"."provider" IN ('gmail', 'google_calendar', 'linear', 'github', 'jamie', 'slack'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_provider_check" CHECK ("goat"."brain_source_items"."source_provider" IN ('jamie', 'goat-chat', 'upload', 'slack'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_type_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_type_check" CHECK ("goat"."brain_source_items"."source_type" IN ('meeting', 'capture', 'asset', 'conversation'));--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_source_provider_check" CHECK ("goat"."brain_ingest_jobs"."source_provider" IN ('jamie', 'goat-chat', 'upload', 'slack'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_integrations_provider_external_idx" ON "goat"."integrations" ("provider","external_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."slack_message_events" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"message_ts" text NOT NULL,
	"thread_ts" text,
	"slack_user_id" text,
	"subtype" text,
	"text" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_slack_message_events_channel_type_check" CHECK ("goat"."slack_message_events"."channel_type" IN ('channel', 'group', 'im', 'mpim'))
);--> statement-breakpoint
ALTER TABLE "goat"."slack_message_events" ADD CONSTRAINT "goat_slack_message_events_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."slack_message_events" ADD CONSTRAINT "goat_slack_message_events_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."slack_message_events" ADD CONSTRAINT "goat_slack_message_events_source_item_id_brain_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "goat"."brain_source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_slack_message_events_integration_channel_ts_idx" ON "goat"."slack_message_events" ("integration_id","channel_id","message_ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_slack_message_events_pending_idx" ON "goat"."slack_message_events" ("integration_id","channel_id","received_at") WHERE "goat"."slack_message_events"."source_item_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_slack_message_events_source_item_idx" ON "goat"."slack_message_events" ("source_item_id");
