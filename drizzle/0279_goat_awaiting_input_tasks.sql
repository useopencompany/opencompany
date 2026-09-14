-- The Task half of 0278. It is a separate migration because the two read models are installed
-- and refreshed independently, each behind its own projection trigger.
ALTER TABLE "goat"."task_read_model_v1" ADD COLUMN "awaiting_input" boolean DEFAULT false NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."refresh_task_read_model_v1"(target_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM goat.tasks AS task
    JOIN goat.chat_sessions AS conversation ON conversation.id = task.session_id
    WHERE task.id = target_id
      AND conversation.kind = 'task'
  ) THEN
    DELETE FROM goat.task_read_model_v1 WHERE id = target_id;
    RETURN;
  END IF;

  INSERT INTO goat.task_read_model_v1 (
    id, actor_id, workspace_id, display_id, name, goal, conversation_id, status, source,
    engine, model, workflow_id, schedule_id, scheduled_for, result, error, reported_status,
    outcome_comment, has_unseen, awaiting_input, archived_at, created_at, updated_at
  )
  SELECT
    task.id, task.user_workos_id, task.workspace_id, task.display_id, task.name, task.prompt,
    conversation.id, goat.canonical_task_status_v1(task.status, task.archived_at), task.source,
    conversation.engine, task.model, task.workflow_id, task.schedule_id, task.scheduled_for,
    task.result, task.error, task.reported_outcome, task.outcome_comment, conversation.has_unseen,
    goat.conversation_awaiting_input_v1(conversation.id),
    task.archived_at, task.created_at, task.updated_at
  FROM goat.tasks AS task
  JOIN goat.chat_sessions AS conversation ON conversation.id = task.session_id
  WHERE task.id = target_id
    AND conversation.kind = 'task'
  ON CONFLICT (id) DO UPDATE SET
    actor_id = EXCLUDED.actor_id,
    workspace_id = EXCLUDED.workspace_id,
    display_id = EXCLUDED.display_id,
    name = EXCLUDED.name,
    goal = EXCLUDED.goal,
    conversation_id = EXCLUDED.conversation_id,
    status = EXCLUDED.status,
    source = EXCLUDED.source,
    engine = EXCLUDED.engine,
    model = EXCLUDED.model,
    workflow_id = EXCLUDED.workflow_id,
    schedule_id = EXCLUDED.schedule_id,
    scheduled_for = EXCLUDED.scheduled_for,
    result = EXCLUDED.result,
    error = EXCLUDED.error,
    reported_status = EXCLUDED.reported_status,
    outcome_comment = EXCLUDED.outcome_comment,
    has_unseen = EXCLUDED.has_unseen,
    awaiting_input = EXCLUDED.awaiting_input,
    archived_at = EXCLUDED.archived_at,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."project_run_approval_task_read_model_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_conversation_id text;
BEGIN
  SELECT run.chat_session_id INTO target_conversation_id
  FROM goat.codex_chat_turns AS run
  WHERE run.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;

  IF target_conversation_id IS NOT NULL THEN
    PERFORM goat.refresh_task_read_model_v1(task.id)
    FROM goat.tasks AS task
    WHERE task.session_id = target_conversation_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "goat_project_run_approval_task_read_model_v1" ON "goat"."run_approvals";--> statement-breakpoint
CREATE TRIGGER "goat_project_run_approval_task_read_model_v1"
AFTER INSERT OR UPDATE OF "status" OR DELETE ON "goat"."run_approvals"
FOR EACH ROW EXECUTE FUNCTION "goat"."project_run_approval_task_read_model_v1"();--> statement-breakpoint

UPDATE goat.task_read_model_v1 AS projection
SET awaiting_input = true
WHERE goat.conversation_awaiting_input_v1(projection.conversation_id);
