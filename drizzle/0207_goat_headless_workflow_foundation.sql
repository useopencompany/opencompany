ALTER TABLE "goat"."workflows"
  ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."task_schedules"
  ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

CREATE TABLE "goat"."automation_command_idempotency" (
  "command_id" text PRIMARY KEY NOT NULL,
  "user_workos_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "operation" text NOT NULL,
  "resource_id" text NOT NULL,
  "transaction_id" bigint DEFAULT pg_current_xact_id()::xid::text::bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "touched_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "goat_automation_command_idempotency_request_hash_check"
    CHECK ("goat"."automation_command_idempotency"."request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "goat_automation_command_idempotency_key_length_check"
    CHECK (length("goat"."automation_command_idempotency"."idempotency_key") BETWEEN 1 AND 200),
  CONSTRAINT "goat_automation_command_idempotency_operation_check"
    CHECK ("goat"."automation_command_idempotency"."operation" IN ('workflow.create', 'task_schedule.create'))
);--> statement-breakpoint
ALTER TABLE "goat"."automation_command_idempotency"
  ADD CONSTRAINT "automation_command_idempotency_user_workos_id_users_workos_user_id_fk"
  FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."automation_command_idempotency"
  ADD CONSTRAINT "automation_command_idempotency_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_automation_command_idempotency_actor_key_idx"
  ON "goat"."automation_command_idempotency" USING btree
  ("user_workos_id", "workspace_id", "idempotency_key");--> statement-breakpoint

CREATE TABLE "goat"."workflow_read_model_v1" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "steps" jsonb NOT NULL,
  "status" text NOT NULL,
  "trigger" jsonb NOT NULL,
  "schedule_cron" text,
  "schedule_timezone" text NOT NULL,
  "schedule_prompt" text NOT NULL,
  "schedule_enabled" boolean NOT NULL,
  "schedule_last_run_at" timestamp with time zone,
  "schedule_next_run_at" timestamp with time zone,
  "version" integer NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX "goat_workflow_read_model_v1_workspace_updated_idx"
  ON "goat"."workflow_read_model_v1" USING btree ("workspace_id", "updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_workflow_read_model_v1_workspace_slug_idx"
  ON "goat"."workflow_read_model_v1" USING btree ("workspace_id", "slug");--> statement-breakpoint

CREATE TABLE "goat"."workflow_schedule_read_model_v1" (
  "id" text PRIMARY KEY NOT NULL,
  "workflow_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "workflow_slug" text NOT NULL,
  "name" text NOT NULL,
  "cron" text NOT NULL,
  "timezone" text NOT NULL,
  "prompt" text NOT NULL,
  "enabled" boolean NOT NULL,
  "last_run_at" timestamp with time zone,
  "next_run_at" timestamp with time zone,
  "version" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX "goat_workflow_schedule_read_model_v1_workspace_updated_idx"
  ON "goat"."workflow_schedule_read_model_v1" USING btree ("workspace_id", "updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_workflow_schedule_read_model_v1_workspace_slug_idx"
  ON "goat"."workflow_schedule_read_model_v1" USING btree ("workspace_id", "workflow_slug");--> statement-breakpoint

CREATE TABLE "goat"."task_schedule_read_model_v1" (
  "id" text PRIMARY KEY NOT NULL,
  "actor_id" text NOT NULL,
  "workspace_id" text,
  "name" text NOT NULL,
  "source_description" text NOT NULL,
  "cron" text NOT NULL,
  "timezone" text NOT NULL,
  "prompt" text NOT NULL,
  "enabled" boolean NOT NULL,
  "last_run_at" timestamp with time zone,
  "next_run_at" timestamp with time zone NOT NULL,
  "version" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX "goat_task_schedule_read_model_v1_actor_workspace_updated_idx"
  ON "goat"."task_schedule_read_model_v1" USING btree
  ("actor_id", "workspace_id", "updated_at");--> statement-breakpoint

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
      jsonb_build_array(
        jsonb_build_object(
          'id', 'step-' || left(NEW.slug, 64),
          'title', '',
          'model', NEW.model,
          'instructions', NEW.instructions
        )
      )
    ELSE '[]'::jsonb
  END;

  INSERT INTO goat.workflow_read_model_v1 (
    id, workspace_id, slug, name, description, steps, status, trigger,
    schedule_cron, schedule_timezone, schedule_prompt, schedule_enabled,
    schedule_last_run_at, schedule_next_run_at, version, archived_at, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.workspace_id, NEW.slug, NEW.name, NEW.description, projected_steps,
    NEW.status,
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

CREATE TRIGGER goat_workflows_project_read_models_v1
AFTER INSERT OR UPDATE OR DELETE ON goat.workflows
FOR EACH ROW EXECUTE FUNCTION goat.project_workflow_read_models_v1();--> statement-breakpoint

CREATE OR REPLACE FUNCTION goat.project_task_schedule_read_model_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_id text;
BEGIN
  source_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  IF TG_OP = 'DELETE' THEN
    DELETE FROM goat.task_schedule_read_model_v1 WHERE id = source_id;
    RETURN OLD;
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM goat.task_schedule_read_model_v1 WHERE id = source_id;
    RETURN NEW;
  END IF;

  INSERT INTO goat.task_schedule_read_model_v1 (
    id, actor_id, workspace_id, name, source_description, cron, timezone, prompt,
    enabled, last_run_at, next_run_at, version, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.user_workos_id, NEW.workspace_id, NEW.name, NEW.source_description,
    NEW.cron, NEW.timezone, NEW.prompt, NEW.enabled, NEW.last_run_at, NEW.next_run_at,
    NEW.version, NEW.created_at, NEW.updated_at
  )
  ON CONFLICT (id) DO UPDATE SET
    actor_id = EXCLUDED.actor_id,
    workspace_id = EXCLUDED.workspace_id,
    name = EXCLUDED.name,
    source_description = EXCLUDED.source_description,
    cron = EXCLUDED.cron,
    timezone = EXCLUDED.timezone,
    prompt = EXCLUDED.prompt,
    enabled = EXCLUDED.enabled,
    last_run_at = EXCLUDED.last_run_at,
    next_run_at = EXCLUDED.next_run_at,
    version = EXCLUDED.version,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER goat_task_schedules_project_read_model_v1
AFTER INSERT OR UPDATE OR DELETE ON goat.task_schedules
FOR EACH ROW EXECUTE FUNCTION goat.project_task_schedule_read_model_v1();--> statement-breakpoint

INSERT INTO goat.workflow_read_model_v1 (
  id, workspace_id, slug, name, description, steps, status, trigger,
  schedule_cron, schedule_timezone, schedule_prompt, schedule_enabled,
  schedule_last_run_at, schedule_next_run_at, version, archived_at, created_at, updated_at
)
SELECT
  workflow.id,
  workflow.workspace_id,
  workflow.slug,
  workflow.name,
  workflow.description,
  CASE
    WHEN jsonb_typeof(workflow.steps) = 'array' AND jsonb_array_length(workflow.steps) > 0
      THEN workflow.steps
    WHEN btrim(workflow.instructions) <> '' OR btrim(workflow.model) <> '' THEN
      jsonb_build_array(
        jsonb_build_object(
          'id', 'step-' || left(workflow.slug, 64),
          'title', '',
          'model', workflow.model,
          'instructions', workflow.instructions
        )
      )
    ELSE '[]'::jsonb
  END,
  workflow.status,
  CASE
    WHEN workflow.trigger = 'schedule' THEN jsonb_build_object(
      'type', 'schedule',
      'cron', COALESCE(NULLIF(btrim(workflow.schedule_cron), ''), '0 9 * * 1'),
      'timezone', COALESCE(NULLIF(btrim(workflow.schedule_timezone), ''), 'UTC'),
      'prompt', COALESCE(NULLIF(btrim(workflow.schedule_prompt), ''), 'Run this workflow.'),
      'enabled', workflow.schedule_enabled,
      'lastRunAt', workflow.schedule_last_run_at,
      'nextRunAt', workflow.schedule_next_run_at
    )
    ELSE jsonb_build_object('type', 'manual')
  END,
  workflow.schedule_cron,
  workflow.schedule_timezone,
  workflow.schedule_prompt,
  workflow.schedule_enabled,
  workflow.schedule_last_run_at,
  workflow.schedule_next_run_at,
  workflow.version,
  workflow.archived_at,
  workflow.created_at,
  workflow.updated_at
FROM goat.workflows AS workflow
WHERE workflow.archived_at IS NULL
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

INSERT INTO goat.workflow_schedule_read_model_v1 (
  id, workflow_id, workspace_id, workflow_slug, name, cron, timezone, prompt,
  enabled, last_run_at, next_run_at, version, created_at, updated_at
)
SELECT
  workflow.id,
  workflow.id,
  workflow.workspace_id,
  workflow.slug,
  workflow.name,
  COALESCE(NULLIF(btrim(workflow.schedule_cron), ''), '0 9 * * 1'),
  COALESCE(NULLIF(btrim(workflow.schedule_timezone), ''), 'UTC'),
  COALESCE(NULLIF(btrim(workflow.schedule_prompt), ''), 'Run this workflow.'),
  workflow.schedule_enabled,
  workflow.schedule_last_run_at,
  workflow.schedule_next_run_at,
  workflow.version,
  workflow.created_at,
  workflow.updated_at
FROM goat.workflows AS workflow
WHERE workflow.archived_at IS NULL
  AND workflow.trigger = 'schedule'
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

INSERT INTO goat.task_schedule_read_model_v1 (
  id, actor_id, workspace_id, name, source_description, cron, timezone, prompt,
  enabled, last_run_at, next_run_at, version, created_at, updated_at
)
SELECT
  schedule.id,
  schedule.user_workos_id,
  schedule.workspace_id,
  schedule.name,
  schedule.source_description,
  schedule.cron,
  schedule.timezone,
  schedule.prompt,
  schedule.enabled,
  schedule.last_run_at,
  schedule.next_run_at,
  schedule.version,
  schedule.created_at,
  schedule.updated_at
FROM goat.task_schedules AS schedule
WHERE schedule.deleted_at IS NULL
ON CONFLICT (id) DO NOTHING;
