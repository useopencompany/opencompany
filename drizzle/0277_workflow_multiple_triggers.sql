ALTER TABLE "goat"."workflows" ADD COLUMN IF NOT EXISTS "automation_triggers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

UPDATE goat.workflows
SET automation_triggers = CASE
  WHEN trigger = 'schedule' THEN jsonb_build_array(jsonb_build_object(
    'id', 'trigger-' || id,
    'type', 'schedule',
    'cron', COALESCE(NULLIF(btrim(schedule_cron), ''), '0 9 * * 1'),
    'timezone', COALESCE(NULLIF(btrim(schedule_timezone), ''), 'UTC'),
    'prompt', COALESCE(NULLIF(btrim(schedule_prompt), ''), 'Run this workflow.'),
    'enabled', schedule_enabled,
    'lastRunAt', schedule_last_run_at,
    'nextRunAt', schedule_next_run_at,
    'userWorkosId', schedule_user_workos_id,
    'activatedAt', created_at,
    'harnessSpec', schedule_harness_spec
  ))
  WHEN trigger = 'event' THEN jsonb_build_array(
    COALESCE(event_config, '{}'::jsonb) || jsonb_build_object(
      'id', 'trigger-' || id,
      'type', 'event',
      'userWorkosId', event_user_workos_id,
      'activatedAt', event_activated_at,
      'harnessSpec', event_harness_spec
    )
  )
  ELSE '[]'::jsonb
END
WHERE automation_triggers = '[]'::jsonb;--> statement-breakpoint

ALTER TABLE "goat"."workflow_schedule_runs" ADD COLUMN IF NOT EXISTS "trigger_id" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
UPDATE goat.workflow_schedule_runs
SET trigger_id = 'trigger-' || workflow_id
WHERE trigger_id = 'legacy';--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_workflow_schedule_runs_workflow_for_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "goat_workflow_schedule_runs_workflow_for_idx" ON "goat"."workflow_schedule_runs" USING btree ("workflow_id", "trigger_id", "scheduled_for");--> statement-breakpoint

ALTER TABLE "goat"."workflow_event_runs" ADD COLUMN IF NOT EXISTS "trigger_id" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
UPDATE goat.workflow_event_runs
SET trigger_id = 'trigger-' || workflow_id
WHERE trigger_id = 'legacy';--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."opencompany_workflow_event_runs_workflow_delivery_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "opencompany_workflow_event_runs_workflow_delivery_idx" ON "goat"."workflow_event_runs" USING btree ("workflow_id", "trigger_id", "provider", "delivery_id");--> statement-breakpoint

ALTER TABLE "goat"."workflow_read_model_v1" ADD COLUMN IF NOT EXISTS "triggers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION goat.project_workflow_read_models_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_id text;
  projected_steps jsonb;
  projected_triggers jsonb;
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

  SELECT COALESCE(
    jsonb_agg(item.value - 'userWorkosId' - 'activatedAt' - 'harnessSpec' ORDER BY item.ordinality),
    '[]'::jsonb
  )
  INTO projected_triggers
  FROM jsonb_array_elements(NEW.automation_triggers) WITH ORDINALITY AS item(value, ordinality);

  INSERT INTO goat.workflow_read_model_v1 (
    id, workspace_id, slug, name, description, steps, status, scope, created_by_workos_id,
    trigger, triggers, schedule_cron, schedule_timezone, schedule_prompt, schedule_enabled,
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
    projected_triggers, NEW.schedule_cron, NEW.schedule_timezone,
    NEW.schedule_prompt, NEW.schedule_enabled, NEW.schedule_last_run_at,
    NEW.schedule_next_run_at, NEW.version, NEW.archived_at, NEW.created_at, NEW.updated_at
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
    triggers = EXCLUDED.triggers,
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
