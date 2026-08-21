-- 0215/0216 recreated refresh_conversation_read_model_v1 with 0201's original guard, which treats
-- every non-chat Conversation as a deletion. The unconditional chat_sessions trigger therefore
-- wiped the canonical Message/Run projections of a Task Conversation on every Conversation-row
-- touch (planner model updates, turn settlement, renames), leaving only rows re-projected by later
-- writes. Distinguish a deleted Conversation (clean up every projection) from a Task Conversation
-- (keep the canonical Message/Run projections that 0202/0204 own; only the chat sidebar summary is
-- chat-scoped).
CREATE OR REPLACE FUNCTION "goat"."refresh_conversation_read_model_v1"(target_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  source_kind text;
BEGIN
  SELECT source.kind
  INTO source_kind
  FROM goat.chat_sessions AS source
  WHERE source.id = target_id;

  IF source_kind IS NULL THEN
    DELETE FROM goat.message_read_model_v1 WHERE conversation_id = target_id;
    DELETE FROM goat.run_read_model_v1 WHERE conversation_id = target_id;
    DELETE FROM goat.conversation_read_model_v1 WHERE id = target_id;
    RETURN;
  END IF;

  IF source_kind <> 'chat' THEN
    DELETE FROM goat.conversation_read_model_v1 WHERE id = target_id;
    RETURN;
  END IF;

  INSERT INTO goat.conversation_read_model_v1 (
    id, actor_id, workspace_id, title, engine, model, archived_at, pinned_at,
    last_seen_at, activity_state, has_unseen, runtime_status, active_run_id,
    runtime_has_error, runtime_updated_at, created_at, updated_at
  )
  SELECT
    source.id, source.user_workos_id, runtime.workspace_id, source.title, source.engine,
    source.model, source.closed_at, source.pinned_at, source.last_seen_at,
    CASE
      WHEN runtime.status IN ('queued', 'starting', 'running')
        OR (
          runtime.active_turn_id IS NOT NULL
          AND runtime.status NOT IN ('failed', 'interrupted', 'closed')
        )
      THEN 'working'
      ELSE 'idle'
    END,
    source.has_unseen, runtime.status, runtime.active_turn_id,
    CASE WHEN runtime.status IS NULL THEN NULL ELSE runtime.error IS NOT NULL END,
    runtime.updated_at, source.created_at, source.updated_at
  FROM goat.chat_sessions AS source
  LEFT JOIN LATERAL (
    SELECT
      candidate.workspace_id,
      candidate.status,
      candidate.active_turn_id,
      candidate.error,
      candidate.updated_at
    FROM goat.codex_chat_sessions AS candidate
    WHERE candidate.chat_session_id = source.id
      AND candidate.user_workos_id = source.user_workos_id
    ORDER BY candidate.updated_at DESC, candidate.id DESC
    LIMIT 1
  ) AS runtime ON true
  WHERE source.id = target_id
    AND source.kind = 'chat'
  ON CONFLICT (id) DO UPDATE SET
    actor_id = EXCLUDED.actor_id,
    workspace_id = EXCLUDED.workspace_id,
    title = EXCLUDED.title,
    engine = EXCLUDED.engine,
    model = EXCLUDED.model,
    archived_at = EXCLUDED.archived_at,
    pinned_at = EXCLUDED.pinned_at,
    last_seen_at = EXCLUDED.last_seen_at,
    activity_state = EXCLUDED.activity_state,
    has_unseen = EXCLUDED.has_unseen,
    runtime_status = EXCLUDED.runtime_status,
    active_run_id = EXCLUDED.active_run_id,
    runtime_has_error = EXCLUDED.runtime_has_error,
    runtime_updated_at = EXCLUDED.runtime_updated_at,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at;
END
$$;--> statement-breakpoint

-- 0202 rescoped already-projected rows runtime-first while the 0204 insert path scopes task-first,
-- so a runtime whose workspace diverges from the owning Task flipped historical rows out of the
-- Task's workspace scope. Align the rewrite with the insert path: the owning Task's workspace wins,
-- the runtime scope is the fallback for plain Chat Conversations.
CREATE OR REPLACE FUNCTION "goat"."project_runtime_scope_read_model_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_conversation_id text;
  target_kind text;
BEGIN
  target_conversation_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.chat_session_id
    ELSE NEW.chat_session_id
  END;
  SELECT conversation.kind
  INTO target_kind
  FROM goat.chat_sessions AS conversation
  WHERE conversation.id = target_conversation_id;

  IF target_kind = 'chat' THEN
    PERFORM goat.refresh_conversation_read_model_v1(target_conversation_id);
  END IF;

  UPDATE goat.message_read_model_v1 AS projection
  SET workspace_id = COALESCE(
    (
      SELECT task.workspace_id
      FROM goat.tasks AS task
      WHERE task.session_id = target_conversation_id
      LIMIT 1
    ),
    (
      SELECT runtime.workspace_id
      FROM goat.codex_chat_sessions AS runtime
      WHERE runtime.chat_session_id = target_conversation_id
        AND runtime.user_workos_id = projection.actor_id
      ORDER BY runtime.updated_at DESC, runtime.id DESC
      LIMIT 1
    )
  )
  WHERE projection.conversation_id = target_conversation_id;

  UPDATE goat.run_read_model_v1 AS projection
  SET workspace_id = COALESCE(
    (
      SELECT task.workspace_id
      FROM goat.tasks AS task
      WHERE task.session_id = target_conversation_id
      LIMIT 1
    ),
    (
      SELECT runtime.workspace_id
      FROM goat.codex_chat_sessions AS runtime
      WHERE runtime.chat_session_id = target_conversation_id
        AND runtime.user_workos_id = projection.actor_id
      ORDER BY runtime.updated_at DESC, runtime.id DESC
      LIMIT 1
    )
  )
  WHERE projection.conversation_id = target_conversation_id;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

-- Repair Task Conversation transcripts the wipe already destroyed. Mirrors the 0204 trigger
-- projection so repaired rows are byte-identical to what the trigger would have written, and
-- upserts so surviving rows converge on the unified workspace scope.
INSERT INTO goat.message_read_model_v1 (
  id, conversation_id, actor_id, workspace_id, role, content, task_id, presentation,
  attachments, created_at, updated_at
)
SELECT
  message.id,
  COALESCE(linked_task.session_id, message.session_id),
  conversation.user_workos_id,
  COALESCE(linked_task.workspace_id, conversation_task.workspace_id, runtime.workspace_id),
  message.role,
  message.content,
  message.task_id,
  goat.chat_presentation_v1(message.debug_trace),
  goat.chat_attachments_v1(message.attachments),
  message.created_at,
  message.updated_at
FROM goat.chat_messages AS message
JOIN goat.chat_sessions AS conversation
  ON conversation.id = message.session_id
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
 AND linked_task.id = message.task_id
 AND linked_task.user_workos_id = conversation.user_workos_id
 AND linked_task.session_id IS NOT NULL
 AND (
   linked_task.workspace_id IS NULL
   OR linked_task.workspace_id = runtime.workspace_id
 )
WHERE conversation.kind = 'task'
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
  updated_at = EXCLUDED.updated_at;--> statement-breakpoint

INSERT INTO goat.run_read_model_v1 (
  id, conversation_id, actor_id, workspace_id, trigger_message_id, assistant_message_id,
  status, engine, model, attempt_count, error, created_at, updated_at
)
SELECT
  run.id,
  COALESCE(linked_task.session_id, run.chat_session_id),
  run.user_workos_id,
  COALESCE(linked_task.workspace_id, conversation_task.workspace_id, runtime.workspace_id),
  run.user_message_id,
  run.assistant_message_id,
  goat.canonical_run_status_v1(run.status),
  runtime.engine,
  runtime.model,
  run.attempts,
  run.error,
  run.created_at,
  run.updated_at
FROM goat.codex_chat_turns AS run
JOIN goat.codex_chat_sessions AS runtime
  ON runtime.id = run.codex_chat_session_id
 AND runtime.user_workos_id = run.user_workos_id
JOIN goat.chat_sessions AS conversation
  ON conversation.id = run.chat_session_id
 AND conversation.user_workos_id = run.user_workos_id
LEFT JOIN goat.chat_messages AS assistant_message
  ON assistant_message.id = run.assistant_message_id
 AND assistant_message.session_id = run.chat_session_id
LEFT JOIN goat.tasks AS linked_task
  ON conversation.kind = 'task'
 AND linked_task.id = assistant_message.task_id
 AND linked_task.user_workos_id = run.user_workos_id
 AND linked_task.session_id IS NOT NULL
 AND (
   linked_task.workspace_id IS NULL
   OR linked_task.workspace_id = runtime.workspace_id
 )
LEFT JOIN goat.tasks AS conversation_task
  ON conversation_task.session_id = conversation.id
 AND conversation_task.user_workos_id = run.user_workos_id
WHERE conversation.kind = 'task'
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
