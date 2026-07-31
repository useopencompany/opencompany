ALTER TABLE "goat"."workflows" ADD COLUMN IF NOT EXISTS "schedule_cron" text;
--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD COLUMN IF NOT EXISTS "schedule_timezone" text DEFAULT 'UTC' NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD COLUMN IF NOT EXISTS "schedule_prompt" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD COLUMN IF NOT EXISTS "schedule_user_workos_id" text;
--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD COLUMN IF NOT EXISTS "schedule_harness_spec" jsonb;
--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD COLUMN IF NOT EXISTS "schedule_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD COLUMN IF NOT EXISTS "schedule_last_run_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD COLUMN IF NOT EXISTS "schedule_next_run_at" timestamp with time zone;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflows_schedule_user_workos_id_users_workos_user_id_fk'
  ) THEN
    ALTER TABLE "goat"."workflows" ADD CONSTRAINT "workflows_schedule_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("schedule_user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_workflows_schedule_due_idx" ON "goat"."workflows" USING btree ("schedule_enabled","schedule_next_run_at") WHERE "trigger" = 'schedule' AND "status" = 'active' AND "archived_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."workflow_schedule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"task_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_workflow_schedule_runs_status_check" CHECK ("goat"."workflow_schedule_runs"."status" IN ('pending', 'created', 'failed'))
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflow_schedule_runs_workflow_id_workflows_id_fk'
  ) THEN
    ALTER TABLE "goat"."workflow_schedule_runs" ADD CONSTRAINT "workflow_schedule_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "goat"."workflows"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflow_schedule_runs_workspace_id_workspaces_id_fk'
  ) THEN
    ALTER TABLE "goat"."workflow_schedule_runs" ADD CONSTRAINT "workflow_schedule_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflow_schedule_runs_user_workos_id_users_workos_user_id_fk'
  ) THEN
    ALTER TABLE "goat"."workflow_schedule_runs" ADD CONSTRAINT "workflow_schedule_runs_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflow_schedule_runs_task_id_tasks_id_fk'
  ) THEN
    ALTER TABLE "goat"."workflow_schedule_runs" ADD CONSTRAINT "workflow_schedule_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_workflow_schedule_runs_workflow_for_idx" ON "goat"."workflow_schedule_runs" USING btree ("workflow_id","scheduled_for");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_workflow_schedule_runs_workspace_created_idx" ON "goat"."workflow_schedule_runs" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_workflow_schedule_runs_user_created_idx" ON "goat"."workflow_schedule_runs" USING btree ("user_workos_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_workflow_schedule_runs_task_idx" ON "goat"."workflow_schedule_runs" USING btree ("task_id");
