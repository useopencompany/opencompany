-- Workflow run activity: how often a workflow fired and when it last did.
--
-- `goat.workflows` is the source of truth; the counters are maintained by an
-- insert trigger on `goat.tasks` and carried into the Electric read model by the
-- existing workflow projection so the overview table streams them live.
--
-- A "run" is one task spawned from the workflow. Counting on task insert keeps
-- the counter exactly-once regardless of later status churn (retries, resumes),
-- which a status-transition trigger cannot guarantee.

ALTER TABLE "goat"."workflows"
  ADD COLUMN IF NOT EXISTS "run_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_executed_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "goat"."workflow_read_model_v1"
  ADD COLUMN IF NOT EXISTS "run_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_executed_at" timestamp with time zone;--> statement-breakpoint

-- `tasks.workflow_id` holds the workspace-scoped workflow slug. The backfill and
-- the trigger both look tasks up by (workspace_id, workflow_id).
CREATE INDEX IF NOT EXISTS "goat_tasks_workspace_workflow_idx"
  ON "goat"."tasks" USING btree ("workspace_id", "workflow_id")
  WHERE "workflow_id" IS NOT NULL;--> statement-breakpoint

UPDATE goat.workflows AS workflow
SET run_count = activity.run_count,
    last_executed_at = activity.last_executed_at
FROM (
  SELECT workspace_id, workflow_id, count(*)::integer AS run_count,
         max(created_at) AS last_executed_at
  FROM goat.tasks
  WHERE workflow_id IS NOT NULL AND workspace_id IS NOT NULL
  GROUP BY workspace_id, workflow_id
) AS activity
WHERE activity.workspace_id = workflow.workspace_id
  AND activity.workflow_id = workflow.slug;--> statement-breakpoint

CREATE OR REPLACE FUNCTION goat.record_workflow_run_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workflow_id IS NULL OR NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE goat.workflows
  SET run_count = run_count + 1,
      last_executed_at = GREATEST(COALESCE(last_executed_at, NEW.created_at), NEW.created_at)
  WHERE workspace_id = NEW.workspace_id
    AND slug = NEW.workflow_id;

  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS record_workflow_run_activity ON goat.tasks;--> statement-breakpoint
CREATE TRIGGER record_workflow_run_activity
AFTER INSERT ON goat.tasks
FOR EACH ROW EXECUTE FUNCTION goat.record_workflow_run_activity();--> statement-breakpoint

-- Re-declared to project the two new columns. Identical to 0222 otherwise.
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
    schedule_last_run_at, schedule_next_run_at, run_count, last_executed_at,
    version, archived_at, created_at, updated_at
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
    NEW.schedule_enabled, NEW.schedule_last_run_at, NEW.schedule_next_run_at,
    NEW.run_count, NEW.last_executed_at, NEW.version,
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
    run_count = EXCLUDED.run_count,
    last_executed_at = EXCLUDED.last_executed_at,
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
