-- Gmail as a Goat Brain ingestion source: widen provider/type checks, add the
-- polled message buffer the runner's Gmail poll worker writes into (flushed per
-- thread into thread-window source items after a quiet period), and the
-- per-integration Gmail history cursor.
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_provider_check" CHECK ("goat"."brain_source_items"."source_provider" IN ('jamie', 'goat-chat', 'upload', 'slack', 'linear', 'github', 'gmail'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_type_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_type_check" CHECK ("goat"."brain_source_items"."source_type" IN ('meeting', 'capture', 'asset', 'conversation', 'issue', 'activity', 'thread'));--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_source_provider_check" CHECK ("goat"."brain_ingest_jobs"."source_provider" IN ('jamie', 'goat-chat', 'upload', 'slack', 'linear', 'github', 'gmail'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."gmail_message_events" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"direction" text NOT NULL,
	"subject" text,
	"from_header" text,
	"payload" jsonb NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_gmail_message_events_direction_check" CHECK ("goat"."gmail_message_events"."direction" IN ('sent', 'received'))
);--> statement-breakpoint
ALTER TABLE "goat"."gmail_message_events" ADD CONSTRAINT "goat_gmail_message_events_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."gmail_message_events" ADD CONSTRAINT "goat_gmail_message_events_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."gmail_message_events" ADD CONSTRAINT "goat_gmail_message_events_source_item_id_brain_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "goat"."brain_source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_gmail_message_events_integration_message_idx" ON "goat"."gmail_message_events" ("integration_id","message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_gmail_message_events_pending_idx" ON "goat"."gmail_message_events" ("integration_id","thread_id","received_at") WHERE "goat"."gmail_message_events"."source_item_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_gmail_message_events_source_item_idx" ON "goat"."gmail_message_events" ("source_item_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."gmail_sync_state" (
	"integration_id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"email_address" text,
	"history_id" text,
	"last_polled_at" timestamp with time zone,
	"last_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "goat"."gmail_sync_state" ADD CONSTRAINT "goat_gmail_sync_state_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."gmail_sync_state" ADD CONSTRAINT "goat_gmail_sync_state_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
