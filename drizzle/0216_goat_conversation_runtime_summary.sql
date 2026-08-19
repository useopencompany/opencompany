ALTER TABLE "goat"."conversation_read_model_v1" ADD COLUMN "runtime_status" text;--> statement-breakpoint
ALTER TABLE "goat"."conversation_read_model_v1" ADD COLUMN "active_run_id" text;--> statement-breakpoint
ALTER TABLE "goat"."conversation_read_model_v1" ADD COLUMN "runtime_has_error" boolean;--> statement-breakpoint
ALTER TABLE "goat"."conversation_read_model_v1" ADD COLUMN "runtime_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "goat"."conversation_read_model_v1" ADD CONSTRAINT "conversation_read_model_v1_runtime_status_check" CHECK ("goat"."conversation_read_model_v1"."runtime_status" IS NULL OR "goat"."conversation_read_model_v1"."runtime_status" IN ('queued', 'starting', 'idle', 'running', 'failed', 'interrupted', 'closed'));--> statement-breakpoint
ALTER TABLE "goat"."conversation_read_model_v1" ADD CONSTRAINT "conversation_read_model_v1_runtime_summary_check" CHECK ((
  "goat"."conversation_read_model_v1"."runtime_status" IS NULL
  AND "goat"."conversation_read_model_v1"."active_run_id" IS NULL
  AND "goat"."conversation_read_model_v1"."runtime_has_error" IS NULL
  AND "goat"."conversation_read_model_v1"."runtime_updated_at" IS NULL
) OR (
  "goat"."conversation_read_model_v1"."runtime_status" IS NOT NULL
  AND "goat"."conversation_read_model_v1"."runtime_has_error" IS NOT NULL
  AND "goat"."conversation_read_model_v1"."runtime_updated_at" IS NOT NULL
));--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."refresh_conversation_read_model_v1"(target_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM goat.chat_sessions AS source
    WHERE source.id = target_id
      AND source.kind = 'chat'
  ) THEN
    DELETE FROM goat.message_read_model_v1 WHERE conversation_id = target_id;
    DELETE FROM goat.run_read_model_v1 WHERE conversation_id = target_id;
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

SELECT goat.refresh_conversation_read_model_v1(source.id)
FROM goat.chat_sessions AS source
WHERE source.kind = 'chat';
