-- Company agents (internal beta). An agent reuses the automation row so it inherits triggers,
-- schedules, event routing, Slack identity, and session continuation unchanged. `kind` is the
-- boundary between the two surfaces, and `owner_workos_id` records the single human whose
-- authorized connections execute an agent's work.
ALTER TABLE "goat"."workflows" ADD COLUMN "kind" text DEFAULT 'workflow' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD COLUMN "owner_workos_id" text;--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD CONSTRAINT "opencompany_workflows_kind_check" CHECK ("kind" IN ('workflow', 'agent'));--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD CONSTRAINT "workflows_owner_workos_id_users_workos_user_id_fk" FOREIGN KEY ("owner_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opencompany_workflows_workspace_kind_updated_idx" ON "goat"."workflows" ("workspace_id","kind","archived_at","updated_at");--> statement-breakpoint

ALTER TABLE "goat"."users" ADD COLUMN "company_agents_enabled" boolean DEFAULT false NOT NULL;
