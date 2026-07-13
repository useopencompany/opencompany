-- Onboarding foundation: per-user onboarded_at gate, a unique workspace URL
-- slug, and a per-user onboarding responses table (referral + company context).
ALTER TABLE "goat"."users" ADD COLUMN IF NOT EXISTS "onboarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "goat"."workspaces" ADD COLUMN IF NOT EXISTS "slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_workspaces_slug_idx" ON "goat"."workspaces" ("slug");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."onboarding" (
	"user_workos_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"referral_source" text,
	"company_domain" text,
	"context_urls" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "goat"."onboarding" ADD CONSTRAINT "goat_onboarding_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."onboarding" ADD CONSTRAINT "goat_onboarding_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE set null ON UPDATE no action;
