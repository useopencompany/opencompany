ALTER TABLE "goat"."task_read_model_v1" ADD COLUMN "has_unseen" boolean DEFAULT false NOT NULL;--> statement-breakpoint
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
    outcome_comment, has_unseen, archived_at, created_at, updated_at
  )
  SELECT
    task.id, task.user_workos_id, task.workspace_id, task.display_id, task.name, task.prompt,
    conversation.id, goat.canonical_task_status_v1(task.status, task.archived_at), task.source,
    conversation.engine, task.model, task.workflow_id, task.schedule_id, task.scheduled_for,
    task.result, task.error, task.reported_outcome, task.outcome_comment, conversation.has_unseen,
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
    archived_at = EXCLUDED.archived_at,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."project_conversation_read_model_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_conversation_id text;
BEGIN
  target_conversation_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  PERFORM goat.refresh_conversation_read_model_v1(target_conversation_id);
  -- A Task's unread state lives on the Task's conversation, so the Task projection has to follow
  -- conversation writes (settlement and acknowledgment) as well as writes to goat.tasks itself.
  PERFORM goat.refresh_task_read_model_v1(task.id)
  FROM goat.tasks AS task
  WHERE task.session_id = target_conversation_id;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

UPDATE goat.task_read_model_v1 AS projection
SET has_unseen = conversation.has_unseen
FROM goat.chat_sessions AS conversation
WHERE conversation.id = projection.conversation_id
  AND conversation.kind = 'task'
  AND projection.has_unseen IS DISTINCT FROM conversation.has_unseen;
