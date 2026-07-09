-- Linear as a Goat Brain ingestion source: widen provider/type checks and add
-- the raw issue-activity buffer the Linear webhook writes into (flushed per
-- issue into issue-window source items by the runner after a quiet period).
ALTER TABLE "goat"."brain_sources" DROP CONSTRAINT IF EXISTS "goat_brain_sources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" ADD CONSTRAINT "goat_brain_sources_provider_check" CHECK ("goat"."brain_sources"."provider" IN ('jamie', 'gmail', 'github', 'slack', 'linear'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_provider_check" CHECK ("goat"."brain_source_items"."source_provider" IN ('jamie', 'goat-chat', 'upload', 'slack', 'linear'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_type_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_type_check" CHECK ("goat"."brain_source_items"."source_type" IN ('meeting', 'capture', 'asset', 'conversation', 'issue'));--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_source_provider_check" CHECK ("goat"."brain_ingest_jobs"."source_provider" IN ('jamie', 'goat-chat', 'upload', 'slack', 'linear'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."linear_issue_events" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"team_id" text,
	"issue_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"action" text NOT NULL,
	"issue_title" text,
	"actor_name" text,
	"payload" jsonb NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_linear_issue_events_entity_type_check" CHECK ("goat"."linear_issue_events"."entity_type" IN ('issue', 'comment')),
	CONSTRAINT "goat_linear_issue_events_action_check" CHECK ("goat"."linear_issue_events"."action" IN ('create', 'update', 'remove'))
);--> statement-breakpoint
ALTER TABLE "goat"."linear_issue_events" ADD CONSTRAINT "goat_linear_issue_events_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."linear_issue_events" ADD CONSTRAINT "goat_linear_issue_events_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."linear_issue_events" ADD CONSTRAINT "goat_linear_issue_events_source_item_id_brain_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "goat"."brain_source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_linear_issue_events_integration_delivery_idx" ON "goat"."linear_issue_events" ("integration_id","delivery_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_linear_issue_events_pending_idx" ON "goat"."linear_issue_events" ("integration_id","issue_id","received_at") WHERE "goat"."linear_issue_events"."source_item_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_linear_issue_events_source_item_idx" ON "goat"."linear_issue_events" ("source_item_id");
