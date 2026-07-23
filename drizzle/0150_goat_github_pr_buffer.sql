-- Buffer pull-request lifecycle activity so an opened PR, its discussion, and
-- its merge can be ingested in one agent pass instead of one pass per webhook.
-- Issue activity intentionally remains on the existing direct-enqueue path.
CREATE TABLE IF NOT EXISTS "goat"."github_pull_request_events" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_github_pull_request_events_event_type_check" CHECK ("goat"."github_pull_request_events"."event_type" IN ('pull_request_opened', 'pull_request_merged', 'pull_request_commented'))
);--> statement-breakpoint
ALTER TABLE "goat"."github_pull_request_events" ADD CONSTRAINT "goat_github_pull_request_events_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."github_pull_request_events" ADD CONSTRAINT "goat_github_pull_request_events_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."github_pull_request_events" ADD CONSTRAINT "goat_github_pull_request_events_source_item_id_brain_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "goat"."brain_source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_github_pull_request_events_integration_delivery_idx" ON "goat"."github_pull_request_events" ("integration_id","delivery_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_github_pull_request_events_pending_idx" ON "goat"."github_pull_request_events" ("integration_id","repository_id","pull_request_number","received_at") WHERE "goat"."github_pull_request_events"."source_item_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_github_pull_request_events_source_item_idx" ON "goat"."github_pull_request_events" ("source_item_id");
