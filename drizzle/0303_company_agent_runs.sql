-- The run half of 0302. It is a separate migration because it installs into the Task projection,
-- which is refreshed by its own trigger and is independent of the automation definition above.
--
-- A run produced by a Company agent belongs to the agent, not to the owner whose authority it
-- used. `agent_id` is what keeps agent runs out of every personal Task list.
ALTER TABLE "goat"."tasks" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD CONSTRAINT "tasks_agent_id_workflows_id_fk" FOREIGN KEY ("agent_id") REFERENCES "goat"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opencompany_tasks_agent_created_at_idx" ON "goat"."tasks" ("agent_id","created_at") WHERE "agent_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "goat"."task_read_model_v1" ADD COLUMN "agent_id" text;--> statement-breakpoint

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
    engine, model, workflow_id, agent_id, schedule_id, scheduled_for, result, error,
    reported_status, outcome_comment, has_unseen, awaiting_input, archived_at, created_at,
    updated_at
  )
  SELECT
    task.id, task.user_workos_id, task.workspace_id, task.display_id, task.name, task.prompt,
    conversation.id, goat.canonical_task_status_v1(task.status, task.archived_at), task.source,
    conversation.engine, task.model, task.workflow_id, task.agent_id, task.schedule_id,
    task.scheduled_for, task.result, task.error, task.reported_outcome, task.outcome_comment,
    conversation.has_unseen, goat.conversation_awaiting_input_v1(conversation.id),
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
    agent_id = EXCLUDED.agent_id,
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

-- Backfill the new projection column for Tasks that already exist.
SELECT goat.refresh_task_read_model_v1(task.id)
FROM goat.tasks AS task
WHERE task.session_id IS NOT NULL;
