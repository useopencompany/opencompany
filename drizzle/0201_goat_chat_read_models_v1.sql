-- API-owned, versioned Electric projections for the first headless Chat slice. These tables are
-- additive and derived: existing Chat/runtime rows remain authoritative and untouched. Legacy
-- owner-only conversations keep a NULL workspace scope so existing users retain access; every
-- canonical write supplies a workspace through its durable runtime.
ALTER TABLE "goat"."run_approvals" ADD COLUMN "tool_call_id" text;--> statement-breakpoint

CREATE TABLE "goat"."conversation_read_model_v1" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"workspace_id" text,
	"title" text NOT NULL,
	"engine" text NOT NULL,
	"model" text NOT NULL,
	"archived_at" timestamp with time zone,
	"pinned_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "goat_conversation_read_model_v1_engine_check" CHECK ("goat"."conversation_read_model_v1"."engine" IN ('opencompany', 'codex', 'claude_code'))
);--> statement-breakpoint

CREATE TABLE "goat"."message_read_model_v1" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"workspace_id" text,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"task_id" text,
	"presentation" jsonb,
	"attachments" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "goat_message_read_model_v1_role_check" CHECK ("goat"."message_read_model_v1"."role" IN ('user', 'assistant'))
);--> statement-breakpoint

CREATE TABLE "goat"."run_read_model_v1" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"workspace_id" text,
	"trigger_message_id" text NOT NULL,
	"assistant_message_id" text NOT NULL,
	"status" text NOT NULL,
	"engine" text NOT NULL,
	"model" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "goat_run_read_model_v1_status_check" CHECK ("goat"."run_read_model_v1"."status" IN ('queued', 'running', 'paused', 'completed', 'failed', 'canceled')),
	CONSTRAINT "goat_run_read_model_v1_engine_check" CHECK ("goat"."run_read_model_v1"."engine" IN ('opencompany', 'codex', 'claude_code')),
	CONSTRAINT "goat_run_read_model_v1_attempt_count_check" CHECK ("goat"."run_read_model_v1"."attempt_count" >= 0)
);--> statement-breakpoint

CREATE INDEX "goat_conversation_read_model_v1_actor_workspace_updated_idx" ON "goat"."conversation_read_model_v1" USING btree ("actor_id","workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "goat_message_read_model_v1_actor_workspace_conversation_idx" ON "goat"."message_read_model_v1" USING btree ("actor_id","workspace_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_run_read_model_v1_actor_workspace_conversation_idx" ON "goat"."run_read_model_v1" USING btree ("actor_id","workspace_id","conversation_id","created_at");--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."canonical_run_status_v1"(physical_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE physical_status
    WHEN 'queued' THEN 'queued'
    WHEN 'running' THEN 'running'
    WHEN 'paused' THEN 'paused'
    WHEN 'completed' THEN 'completed'
    WHEN 'failed' THEN 'failed'
    WHEN 'interrupted' THEN 'canceled'
    ELSE 'failed'
  END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."chat_presentation_v1"(debug_trace jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN debug_trace IS NULL THEN NULL
    ELSE jsonb_strip_nulls(jsonb_build_object(
      'schemaVersion', debug_trace -> 'schemaVersion',
      'model', debug_trace -> 'model',
      'aborted', debug_trace -> 'aborted',
      'finishReason', debug_trace -> 'finishReason',
      'uiMessageParts', debug_trace -> 'uiMessageParts',
      'durationMs', debug_trace -> 'durationMs',
      'usage', debug_trace -> 'usage',
      'error', debug_trace -> 'error',
      'scheduledWakeup', debug_trace -> 'scheduledWakeup'
    ))
  END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."chat_attachments_v1"(attachments jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN attachments IS NULL THEN NULL
    WHEN jsonb_typeof(attachments) <> 'array' THEN '[]'::jsonb
    ELSE COALESCE(
      (
        SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'id', attachment.value -> 'id',
          'filename', attachment.value -> 'filename',
          'mediaType', attachment.value -> 'mediaType',
          'sizeBytes', attachment.value -> 'sizeBytes',
          'kind', attachment.value -> 'kind'
        )) ORDER BY attachment.ordinality)
        FROM jsonb_array_elements(attachments) WITH ORDINALITY AS attachment(value, ordinality)
      ),
      '[]'::jsonb
    )
  END
$$;--> statement-breakpoint

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
    last_seen_at, created_at, updated_at
  )
  SELECT
    source.id, source.user_workos_id, runtime.workspace_id, source.title, source.engine,
    source.model, source.closed_at, source.pinned_at, source.last_seen_at,
    source.created_at, source.updated_at
  FROM goat.chat_sessions AS source
  LEFT JOIN LATERAL (
    SELECT candidate.workspace_id
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
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."project_conversation_read_model_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM goat.refresh_conversation_read_model_v1(OLD.id);
    RETURN OLD;
  END IF;
  PERFORM goat.refresh_conversation_read_model_v1(NEW.id);
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."project_runtime_scope_read_model_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_conversation_id text;
BEGIN
  target_conversation_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.chat_session_id ELSE NEW.chat_session_id END;
  PERFORM goat.refresh_conversation_read_model_v1(target_conversation_id);
  UPDATE goat.message_read_model_v1 AS projection
  SET workspace_id = (
    SELECT runtime.workspace_id
    FROM goat.codex_chat_sessions AS runtime
    WHERE runtime.chat_session_id = target_conversation_id
      AND runtime.user_workos_id = projection.actor_id
    ORDER BY runtime.updated_at DESC, runtime.id DESC
    LIMIT 1
  )
  WHERE projection.conversation_id = target_conversation_id
  ;
  UPDATE goat.run_read_model_v1 AS projection
  SET workspace_id = (
    SELECT runtime.workspace_id
    FROM goat.codex_chat_sessions AS runtime
    WHERE runtime.chat_session_id = target_conversation_id
      AND runtime.user_workos_id = projection.actor_id
    ORDER BY runtime.updated_at DESC, runtime.id DESC
    LIMIT 1
  )
  WHERE projection.conversation_id = target_conversation_id;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

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
    NEW.id, NEW.session_id, conversation.user_workos_id, runtime.workspace_id, NEW.role,
    NEW.content, NEW.task_id, goat.chat_presentation_v1(NEW.debug_trace),
    goat.chat_attachments_v1(NEW.attachments), NEW.created_at, NEW.updated_at
  FROM goat.chat_sessions AS conversation
  LEFT JOIN LATERAL (
    SELECT candidate.workspace_id
    FROM goat.codex_chat_sessions AS candidate
    WHERE candidate.chat_session_id = conversation.id
      AND candidate.user_workos_id = conversation.user_workos_id
    ORDER BY candidate.updated_at DESC, candidate.id DESC
    LIMIT 1
  ) AS runtime ON true
  WHERE conversation.id = NEW.session_id
    AND conversation.kind = 'chat'
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
    NEW.id, NEW.chat_session_id, NEW.user_workos_id, runtime.workspace_id,
    NEW.user_message_id, NEW.assistant_message_id, goat.canonical_run_status_v1(NEW.status),
    runtime.engine, runtime.model, NEW.attempts, NEW.error, NEW.created_at, NEW.updated_at
  FROM goat.codex_chat_sessions AS runtime
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

CREATE TRIGGER "goat_project_conversation_read_model_v1"
AFTER INSERT OR UPDATE OR DELETE ON "goat"."chat_sessions"
FOR EACH ROW EXECUTE FUNCTION "goat"."project_conversation_read_model_v1"();--> statement-breakpoint
CREATE TRIGGER "goat_project_runtime_scope_read_model_v1"
AFTER INSERT OR UPDATE OR DELETE ON "goat"."codex_chat_sessions"
FOR EACH ROW EXECUTE FUNCTION "goat"."project_runtime_scope_read_model_v1"();--> statement-breakpoint
CREATE TRIGGER "goat_project_message_read_model_v1"
AFTER INSERT OR UPDATE OR DELETE ON "goat"."chat_messages"
FOR EACH ROW EXECUTE FUNCTION "goat"."project_message_read_model_v1"();--> statement-breakpoint
CREATE TRIGGER "goat_project_run_read_model_v1"
AFTER INSERT OR UPDATE OR DELETE ON "goat"."codex_chat_turns"
FOR EACH ROW EXECUTE FUNCTION "goat"."project_run_read_model_v1"();--> statement-breakpoint

SELECT goat.refresh_conversation_read_model_v1(source.id)
FROM goat.chat_sessions AS source
WHERE source.kind = 'chat';--> statement-breakpoint
INSERT INTO goat.message_read_model_v1 (
  id, conversation_id, actor_id, workspace_id, role, content, task_id, presentation,
  attachments, created_at, updated_at
)
SELECT
  message.id, message.session_id, conversation.user_workos_id, runtime.workspace_id,
  message.role, message.content, message.task_id, goat.chat_presentation_v1(message.debug_trace),
  goat.chat_attachments_v1(message.attachments),
  message.created_at, message.updated_at
FROM goat.chat_messages AS message
JOIN goat.chat_sessions AS conversation ON conversation.id = message.session_id
LEFT JOIN LATERAL (
  SELECT candidate.workspace_id
  FROM goat.codex_chat_sessions AS candidate
  WHERE candidate.chat_session_id = conversation.id
    AND candidate.user_workos_id = conversation.user_workos_id
  ORDER BY candidate.updated_at DESC, candidate.id DESC
  LIMIT 1
) AS runtime ON true
WHERE conversation.kind = 'chat'
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint
INSERT INTO goat.run_read_model_v1 (
  id, conversation_id, actor_id, workspace_id, trigger_message_id, assistant_message_id,
  status, engine, model, attempt_count, error, created_at, updated_at
)
SELECT
  run.id, run.chat_session_id, run.user_workos_id, runtime.workspace_id,
  run.user_message_id, run.assistant_message_id, goat.canonical_run_status_v1(run.status),
  runtime.engine, runtime.model, run.attempts, run.error, run.created_at, run.updated_at
FROM goat.codex_chat_turns AS run
JOIN goat.codex_chat_sessions AS runtime ON runtime.id = run.codex_chat_session_id
ON CONFLICT (id) DO NOTHING;
