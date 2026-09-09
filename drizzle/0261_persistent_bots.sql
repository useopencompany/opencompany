ALTER TABLE goat.users ADD COLUMN bots_enabled boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE goat.chat_sessions ADD COLUMN bot_name text;--> statement-breakpoint
ALTER TABLE goat.chat_sessions ADD COLUMN bot_description text;--> statement-breakpoint
ALTER TABLE goat.chat_sessions ADD CONSTRAINT chat_sessions_bot_identity_check CHECK (
  (bot_name IS NULL AND bot_description IS NULL) OR
  (bot_name IS NOT NULL AND bot_description IS NOT NULL AND length(btrim(bot_name)) BETWEEN 1 AND 80 AND length(bot_description) <= 4000 AND kind = 'chat')
);--> statement-breakpoint
ALTER TABLE goat.conversation_read_model_v1 ADD COLUMN is_bot boolean NOT NULL DEFAULT false;--> statement-breakpoint
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
    id, actor_id, workspace_id, title, engine, model, is_bot, archived_at, pinned_at,
    last_seen_at, activity_state, has_unseen, runtime_status, active_run_id,
    runtime_has_error, runtime_updated_at, created_at, updated_at
  )
  SELECT
    source.id, source.user_workos_id, runtime.workspace_id, source.title, source.engine,
    source.model, source.bot_name IS NOT NULL, source.closed_at, source.pinned_at, source.last_seen_at,
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
    is_bot = EXCLUDED.is_bot,
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
