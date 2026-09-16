CREATE TABLE "goat"."posthog_event_sync_state" (
	"integration_id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"ingested_at_cursor" text NOT NULL,
	"event_uuid_cursor" text DEFAULT '' NOT NULL,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."posthog_event_sync_state" ADD CONSTRAINT "posthog_event_sync_state_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."posthog_event_sync_state" ADD CONSTRAINT "posthog_event_sync_state_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
