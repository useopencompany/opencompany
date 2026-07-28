-- Extract Workflows and Skills out of the Brain into their own workspace-scoped
-- primitives. They were previously stored as markdown documents in reserved
-- `workflows/` and `skills/` Brain folders; this makes "how work happens"
-- company-level rather than Brain (knowledge) content. `slug` is the stable
-- handle used by the `#` (workflow) and `@skill/<slug>` composer mentions.
CREATE TABLE IF NOT EXISTS "goat"."workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_workos_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "goat_workflows_status_check" CHECK ("status" IN ('draft', 'active'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."skills" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_workos_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "goat_skills_status_check" CHECK ("status" IN ('draft', 'active'))
);--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD CONSTRAINT "goat_workflows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD CONSTRAINT "goat_workflows_created_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("created_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."skills" ADD CONSTRAINT "goat_skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."skills" ADD CONSTRAINT "goat_skills_created_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("created_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_workflows_workspace_slug_idx" ON "goat"."workflows" ("workspace_id","slug") WHERE "archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_workflows_workspace_updated_idx" ON "goat"."workflows" ("workspace_id","archived_at","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_skills_workspace_slug_idx" ON "goat"."skills" ("workspace_id","slug") WHERE "archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_skills_workspace_updated_idx" ON "goat"."skills" ("workspace_id","archived_at","updated_at");
