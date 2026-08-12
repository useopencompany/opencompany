-- Preserve pre-cutover multi-step Task history without mutating its physical Conversations.
-- Only task-kind Conversations with an owner- and workspace-matched task_id are projected through
-- the Task's one canonical Conversation. Normal Chat task cards keep their original identity.
CREATE OR REPLACE FUNCTION "goat"."project_message_read_model_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM goat.message_read_model_v1 WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  INSERT INTO goat.message_read_model_v1 (
    id, conversation_id, actor_id, workspace_id, role, content, task_id, presentation,
    attachments, created_at, updated_at
  )
  SELECT
    NEW.id,
    COALESCE(linked_task.session_id, NEW.session_id),
    conversation.user_workos_id,
    COALESCE(linked_task.workspace_id, conversation_task.workspace_id, runtime.workspace_id),
    NEW.role,
    NEW.content,
    NEW.task_id,
    goat.chat_presentation_v1(NEW.debug_trace),
    goat.chat_attachments_v1(NEW.attachments),
    NEW.created_at,
    NEW.updated_at
  FROM goat.chat_sessions AS conversation
  LEFT JOIN goat.tasks AS conversation_task
    ON conversation_task.session_id = conversation.id
   AND conversation_task.user_workos_id = conversation.user_workos_id
  LEFT JOIN LATERAL (
    SELECT candidate.workspace_id
    FROM goat.codex_chat_sessions AS candidate
    WHERE candidate.chat_session_id = conversation.id
      AND candidate.user_workos_id = conversation.user_workos_id
    ORDER BY candidate.updated_at DESC, candidate.id DESC
    LIMIT 1
  ) AS runtime ON true
  LEFT JOIN goat.tasks AS linked_task
    ON conversation.kind = 'task'
   AND linked_task.id = NEW.task_id
   AND linked_task.user_workos_id = conversation.user_workos_id
   AND linked_task.session_id IS NOT NULL
   AND (
     linked_task.workspace_id IS NULL
     OR linked_task.workspace_id = runtime.workspace_id
   )
  WHERE conversation.id = NEW.session_id
    AND conversation.kind IN ('chat', 'task')
  ON CONFLICT (id) DO UPDATE SET
    conversation_id = EXCLUDED.conversation_id,
    actor_id = EXCLUDED.actor_id,
    workspace_id = EXCLUDED.workspace_id,
    role = EXCLUDED.role,
    content = EXCLUDED.content,
    task_id = EXCLUDED.task_id,
    presentation = EXCLUDED.presentation,
    attachments = EXCLUDED.attachments,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."project_run_read_model_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM goat.run_read_model_v1 WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  INSERT INTO goat.run_read_model_v1 (
    id, conversation_id, actor_id, workspace_id, trigger_message_id, assistant_message_id,
    status, engine, model, attempt_count, error, created_at, updated_at
  )
  SELECT
    NEW.id,
    COALESCE(linked_task.session_id, NEW.chat_session_id),
    NEW.user_workos_id,
    COALESCE(linked_task.workspace_id, conversation_task.workspace_id, runtime.workspace_id),
    NEW.user_message_id,
    NEW.assistant_message_id,
    goat.canonical_run_status_v1(NEW.status),
    runtime.engine,
    runtime.model,
    NEW.attempts,
    NEW.error,
    NEW.created_at,
    NEW.updated_at
  FROM goat.codex_chat_sessions AS runtime
  JOIN goat.chat_sessions AS conversation
    ON conversation.id = NEW.chat_session_id
   AND conversation.user_workos_id = NEW.user_workos_id
  LEFT JOIN goat.chat_messages AS assistant_message
    ON assistant_message.id = NEW.assistant_message_id
   AND assistant_message.session_id = NEW.chat_session_id
  LEFT JOIN goat.tasks AS linked_task
    ON conversation.kind = 'task'
   AND linked_task.id = assistant_message.task_id
   AND linked_task.user_workos_id = NEW.user_workos_id
   AND linked_task.session_id IS NOT NULL
   AND (
     linked_task.workspace_id IS NULL
     OR linked_task.workspace_id = runtime.workspace_id
   )
  LEFT JOIN goat.tasks AS conversation_task
    ON conversation_task.session_id = conversation.id
   AND conversation_task.user_workos_id = NEW.user_workos_id
  WHERE runtime.id = NEW.codex_chat_session_id
    AND runtime.user_workos_id = NEW.user_workos_id
  ON CONFLICT (id) DO UPDATE SET
    conversation_id = EXCLUDED.conversation_id,
    actor_id = EXCLUDED.actor_id,
    workspace_id = EXCLUDED.workspace_id,
    trigger_message_id = EXCLUDED.trigger_message_id,
    assistant_message_id = EXCLUDED.assistant_message_id,
    status = EXCLUDED.status,
    engine = EXCLUDED.engine,
    model = EXCLUDED.model,
    attempt_count = EXCLUDED.attempt_count,
    error = EXCLUDED.error,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END
$$;--> statement-breakpoint

-- Repoint only the additive API projections. The physical Message, Run, runtime, and prior
-- Conversation rows remain unchanged and continue to provide a reversible compatibility source.
UPDATE goat.message_read_model_v1 AS projection
SET conversation_id = task.session_id,
    workspace_id = COALESCE(task.workspace_id, projection.workspace_id)
FROM goat.chat_messages AS message
JOIN goat.chat_sessions AS conversation
  ON conversation.id = message.session_id
 AND conversation.kind = 'task'
JOIN goat.tasks AS task
  ON task.id = message.task_id
 AND task.user_workos_id = conversation.user_workos_id
 AND task.session_id IS NOT NULL
WHERE projection.id = message.id
  AND projection.actor_id = task.user_workos_id
  AND (
    task.workspace_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM goat.codex_chat_sessions AS runtime
      WHERE runtime.chat_session_id = conversation.id
        AND runtime.user_workos_id = task.user_workos_id
        AND runtime.workspace_id = task.workspace_id
    )
  )
  AND projection.conversation_id IS DISTINCT FROM task.session_id;--> statement-breakpoint

UPDATE goat.run_read_model_v1 AS projection
SET conversation_id = task.session_id,
    workspace_id = COALESCE(task.workspace_id, projection.workspace_id)
FROM goat.codex_chat_turns AS run
JOIN goat.codex_chat_sessions AS runtime
  ON runtime.id = run.codex_chat_session_id
 AND runtime.user_workos_id = run.user_workos_id
JOIN goat.chat_sessions AS conversation
  ON conversation.id = run.chat_session_id
 AND conversation.kind = 'task'
JOIN goat.chat_messages AS assistant_message
  ON assistant_message.id = run.assistant_message_id
 AND assistant_message.session_id = run.chat_session_id
JOIN goat.tasks AS task
  ON task.id = assistant_message.task_id
 AND task.user_workos_id = run.user_workos_id
 AND task.session_id IS NOT NULL
WHERE projection.id = run.id
  AND projection.actor_id = task.user_workos_id
  AND (
    task.workspace_id IS NULL
    OR task.workspace_id = runtime.workspace_id
  )
  AND projection.conversation_id IS DISTINCT FROM task.session_id;
