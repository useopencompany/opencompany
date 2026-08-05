-- Durable, harness-neutral action discovery, invocation, and metered-capability
-- governance. One row is shared by every HTTP request and app instance serving
-- the same model turn.
CREATE TABLE "goat"."action_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"policy" text NOT NULL,
	"action_call_count" integer DEFAULT 0 NOT NULL,
	"invocation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"listed_source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quoted_total_usd_micros" bigint DEFAULT 0 NOT NULL,
	"admitted_invocation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capability_quotes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"async_runs_started" integer DEFAULT 0 NOT NULL,
	"async_invocation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_action_turns_policy_check" CHECK ("policy" IN ('foregroundInteractive', 'cloudReadOnly', 'headless')),
	CONSTRAINT "goat_action_turns_counters_check" CHECK (
		"action_call_count" >= 0
		AND "quoted_total_usd_micros" >= 0
		AND "async_runs_started" >= 0
	)
);
--> statement-breakpoint
ALTER TABLE "goat"."action_turns" ADD CONSTRAINT "goat_action_turns_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."action_turns" ADD CONSTRAINT "goat_action_turns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "goat_action_turns_session_turn_idx" ON "goat"."action_turns" USING btree ("session_id", "turn_id");
--> statement-breakpoint
CREATE INDEX "goat_action_turns_expires_idx" ON "goat"."action_turns" USING btree ("expires_at");
