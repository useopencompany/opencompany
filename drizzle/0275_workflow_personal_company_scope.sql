-- Gives workflows the same personal/company visibility Skills already have. Existing workflows
-- belong to the whole workspace, so they stay company workflows.
ALTER TABLE "goat"."workflows"
  ADD COLUMN "scope" text DEFAULT 'company' NOT NULL;--> statement-breakpoint

ALTER TABLE "goat"."workflows"
  ADD CONSTRAINT "opencompany_workflows_scope_check"
  CHECK ("goat"."workflows"."scope" IN ('personal', 'company'));--> statement-breakpoint

-- created_by_workos_id is set to NULL when a user row is deleted, so an owner cannot be required
-- by a constraint. Readers treat a personal row without an owner as visible to nobody.
CREATE INDEX "opencompany_workflows_personal_owner_idx"
  ON "goat"."workflows" USING btree ("workspace_id", "created_by_workos_id")
  WHERE "scope" = 'personal' AND "archived_at" IS NULL;--> statement-breakpoint

-- The projection trigger below is this table's only writer and always supplies a scope. The
-- default exists solely to fill the rows that are already projected, then it goes away.
ALTER TABLE "goat"."workflow_read_model_v1"
  ADD COLUMN "scope" text DEFAULT 'company' NOT NULL,
  ADD COLUMN "created_by_workos_id" text;--> statement-breakpoint
ALTER TABLE "goat"."workflow_read_model_v1"
  ALTER COLUMN "scope" DROP DEFAULT;--> statement-breakpoint

-- Electric filters the shape on these columns, so the projection has to carry them.
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
    id, workspace_id, slug, name, description, steps, status, scope, created_by_workos_id, trigger,
    schedule_cron, schedule_timezone, schedule_prompt, schedule_enabled,
    schedule_last_run_at, schedule_next_run_at, version, archived_at, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.workspace_id, NEW.slug, NEW.name, NEW.description, projected_steps, NEW.status,
    NEW.scope, NEW.created_by_workos_id,
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
    scope = EXCLUDED.scope,
    created_by_workos_id = EXCLUDED.created_by_workos_id,
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

-- Replay every live workflow through the trigger so the new read-model columns are populated.
UPDATE goat.workflows SET updated_at = updated_at WHERE archived_at IS NULL;
