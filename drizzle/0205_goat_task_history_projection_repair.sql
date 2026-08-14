-- Repair projection rows that may be absent for pre-cutover Task history. The source Conversations,
-- Messages, Runs, and runtimes remain unchanged; only the rebuildable v1 read models are upserted.
INSERT INTO goat.message_read_model_v1 (
  id, conversation_id, actor_id, workspace_id, role, content, task_id, presentation,
  attachments, created_at, updated_at
)
SELECT
  message.id,
  task.session_id,
  conversation.user_workos_id,
  COALESCE(task.workspace_id, runtime.workspace_id),
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
 AND conversation.kind = 'task'
JOIN goat.tasks AS task
  ON task.id = message.task_id
 AND task.user_workos_id = conversation.user_workos_id
 AND task.session_id IS NOT NULL
 AND task.session_id IS DISTINCT FROM message.session_id
LEFT JOIN LATERAL (
  SELECT candidate.workspace_id
  FROM goat.codex_chat_sessions AS candidate
  WHERE candidate.chat_session_id = conversation.id
    AND candidate.user_workos_id = conversation.user_workos_id
  ORDER BY candidate.updated_at DESC, candidate.id DESC
  LIMIT 1
) AS runtime ON true
WHERE task.workspace_id IS NULL
   OR task.workspace_id = runtime.workspace_id
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
  task.session_id,
  run.user_workos_id,
  COALESCE(task.workspace_id, runtime.workspace_id),
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
 AND conversation.kind = 'task'
 AND conversation.user_workos_id = run.user_workos_id
JOIN goat.chat_messages AS assistant_message
  ON assistant_message.id = run.assistant_message_id
 AND assistant_message.session_id = run.chat_session_id
JOIN goat.tasks AS task
  ON task.id = assistant_message.task_id
 AND task.user_workos_id = run.user_workos_id
 AND task.session_id IS NOT NULL
 AND task.session_id IS DISTINCT FROM run.chat_session_id
WHERE task.workspace_id IS NULL
   OR task.workspace_id = runtime.workspace_id
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
