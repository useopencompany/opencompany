-- Adds the first provider event route and its durable task-creation inbox.
ALTER TABLE "goat"."workflows"
  ADD COLUMN "event_config" jsonb,
  ADD COLUMN "event_user_workos_id" text,
  ADD COLUMN "event_harness_spec" jsonb;--> statement-breakpoint

ALTER TABLE "goat"."workflows"
  ADD CONSTRAINT "workflows_event_user_workos_id_users_workos_user_id_fk"
  FOREIGN KEY ("event_user_workos_id") REFERENCES "goat"."users"("workos_user_id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "goat"."workflows"
  DROP CONSTRAINT "goat_workflows_trigger_check";--> statement-breakpoint
ALTER TABLE "goat"."workflows"
  ADD CONSTRAINT "goat_workflows_trigger_check"
  CHECK ("goat"."workflows"."trigger" IN ('manual', 'slack', 'linear', 'schedule', 'event'));--> statement-breakpoint

CREATE INDEX "opencompany_workflows_event_route_idx"
  ON "goat"."workflows" USING btree ("event_user_workos_id", "trigger")
  WHERE "trigger" = 'event' AND "archived_at" IS NULL;--> statement-breakpoint

CREATE TABLE "goat"."workflow_event_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "workflow_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "user_workos_id" text NOT NULL,
  "workflow_slug" text NOT NULL,
  "workflow_name" text NOT NULL,
  "provider" text NOT NULL,
  "event_type" text NOT NULL,
  "delivery_id" text NOT NULL,
  "goal" text NOT NULL,
  "harness_spec" jsonb NOT NULL,
  "event_at" timestamp with time zone NOT NULL,
  "task_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "opencompany_workflow_event_runs_provider_check" CHECK ("provider" IN ('linear')),
  CONSTRAINT "opencompany_workflow_event_runs_status_check" CHECK ("status" IN ('pending', 'created', 'ignored', 'failed'))
);--> statement-breakpoint
ALTER TABLE "goat"."workflow_event_runs"
  ADD CONSTRAINT "workflow_event_runs_workflow_id_workflows_id_fk"
  FOREIGN KEY ("workflow_id") REFERENCES "goat"."workflows"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."workflow_event_runs"
  ADD CONSTRAINT "workflow_event_runs_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."workflow_event_runs"
  ADD CONSTRAINT "workflow_event_runs_user_workos_id_users_workos_user_id_fk"
  FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."workflow_event_runs"
  ADD CONSTRAINT "workflow_event_runs_task_id_tasks_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opencompany_workflow_event_runs_workflow_delivery_idx"
  ON "goat"."workflow_event_runs" USING btree ("workflow_id", "provider", "delivery_id");--> statement-breakpoint
CREATE INDEX "opencompany_workflow_event_runs_pending_idx"
  ON "goat"."workflow_event_runs" USING btree ("status", "next_attempt_at", "created_at")
  WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "opencompany_workflow_event_runs_task_idx"
  ON "goat"."workflow_event_runs" USING btree ("task_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION goat.project_workflow_read_models_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_id text;
  projected_steps jsonb;
BEGIN
  source_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;

  IF TG_OP = 'DELETE' THEN
    DELETE FROM goat.workflow_schedule_read_model_v1 WHERE id = source_id;
    DELETE FROM goat.workflow_read_model_v1 WHERE id = source_id;
    RETURN OLD;
  END IF;

  IF NEW.archived_at IS NOT NULL THEN
    DELETE FROM goat.workflow_schedule_read_model_v1 WHERE id = source_id;
    DELETE FROM goat.workflow_read_model_v1 WHERE id = source_id;
    RETURN NEW;
  END IF;

  projected_steps := CASE
    WHEN jsonb_typeof(NEW.steps) = 'array' AND jsonb_array_length(NEW.steps) > 0 THEN NEW.steps
    WHEN btrim(NEW.instructions) <> '' OR btrim(NEW.model) <> '' THEN
      jsonb_build_array(jsonb_build_object(
        'id', 'step-' || left(NEW.slug, 64), 'title', '',
        'model', NEW.model, 'instructions', NEW.instructions
      ))
    ELSE '[]'::jsonb
  END;

  INSERT INTO goat.workflow_read_model_v1 (
    id, workspace_id, slug, name, description, steps, status, trigger,
    schedule_cron, schedule_timezone, schedule_prompt, schedule_enabled,
    schedule_last_run_at, schedule_next_run_at, version, archived_at, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.workspace_id, NEW.slug, NEW.name, NEW.description, projected_steps, NEW.status,
    CASE
      WHEN NEW.trigger = 'schedule' THEN jsonb_build_object(
        'type', 'schedule',
        'cron', COALESCE(NULLIF(btrim(NEW.schedule_cron), ''), '0 9 * * 1'),
        'timezone', COALESCE(NULLIF(btrim(NEW.schedule_timezone), ''), 'UTC'),
        'prompt', COALESCE(NULLIF(btrim(NEW.schedule_prompt), ''), 'Run this workflow.'),
        'enabled', NEW.schedule_enabled,
        'lastRunAt', NEW.schedule_last_run_at,
        'nextRunAt', NEW.schedule_next_run_at
      )
      WHEN NEW.trigger = 'event' THEN
        COALESCE(NEW.event_config, '{}'::jsonb) || jsonb_build_object('type', 'event')
      ELSE jsonb_build_object('type', 'manual')
    END,
    NEW.schedule_cron, NEW.schedule_timezone, NEW.schedule_prompt,
    NEW.schedule_enabled, NEW.schedule_last_run_at, NEW.schedule_next_run_at, NEW.version,
    NEW.archived_at, NEW.created_at, NEW.updated_at
  )
  ON CONFLICT (id) DO UPDATE SET
    workspace_id = EXCLUDED.workspace_id,
    slug = EXCLUDED.slug,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    steps = EXCLUDED.steps,
    status = EXCLUDED.status,
    trigger = EXCLUDED.trigger,
    schedule_cron = EXCLUDED.schedule_cron,
    schedule_timezone = EXCLUDED.schedule_timezone,
    schedule_prompt = EXCLUDED.schedule_prompt,
    schedule_enabled = EXCLUDED.schedule_enabled,
    schedule_last_run_at = EXCLUDED.schedule_last_run_at,
    schedule_next_run_at = EXCLUDED.schedule_next_run_at,
    version = EXCLUDED.version,
    archived_at = EXCLUDED.archived_at,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at;

  IF NEW.trigger = 'schedule' THEN
    INSERT INTO goat.workflow_schedule_read_model_v1 (
      id, workflow_id, workspace_id, workflow_slug, name, cron, timezone, prompt,
      enabled, last_run_at, next_run_at, version, created_at, updated_at
    ) VALUES (
      NEW.id, NEW.id, NEW.workspace_id, NEW.slug, NEW.name,
      COALESCE(NULLIF(btrim(NEW.schedule_cron), ''), '0 9 * * 1'),
      COALESCE(NULLIF(btrim(NEW.schedule_timezone), ''), 'UTC'),
      COALESCE(NULLIF(btrim(NEW.schedule_prompt), ''), 'Run this workflow.'), NEW.schedule_enabled,
      NEW.schedule_last_run_at, NEW.schedule_next_run_at, NEW.version,
      NEW.created_at, NEW.updated_at
    )
    ON CONFLICT (id) DO UPDATE SET
      workflow_id = EXCLUDED.workflow_id,
      workspace_id = EXCLUDED.workspace_id,
      workflow_slug = EXCLUDED.workflow_slug,
      name = EXCLUDED.name,
      cron = EXCLUDED.cron,
      timezone = EXCLUDED.timezone,
      prompt = EXCLUDED.prompt,
      enabled = EXCLUDED.enabled,
      last_run_at = EXCLUDED.last_run_at,
      next_run_at = EXCLUDED.next_run_at,
      version = EXCLUDED.version,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at;
  ELSE
    DELETE FROM goat.workflow_schedule_read_model_v1 WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

UPDATE goat.workflows SET updated_at = updated_at WHERE archived_at IS NULL;
