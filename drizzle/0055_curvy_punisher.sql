CREATE TABLE "workspace_spend_limits" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"daily_cap_usd_micros" bigint,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_spend_limits_daily_cap_positive_check" CHECK ("workspace_spend_limits"."daily_cap_usd_micros" IS NULL OR "workspace_spend_limits"."daily_cap_usd_micros" > 0)
);
--> statement-breakpoint
ALTER TABLE "workspace_spend_limits" ADD CONSTRAINT "workspace_spend_limits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_spend_limits" ADD CONSTRAINT "workspace_spend_limits_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;