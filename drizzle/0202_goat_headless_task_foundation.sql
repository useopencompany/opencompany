-- Additive foundation for canonical Tasks. Existing Task rows and legacy history remain untouched;
-- sessionless rows stay on the bounded compatibility reader until the later backfill phase.
ALTER TABLE "goat"."tasks" ADD COLUMN "source" text;--> statement-breakpoint
UPDATE "goat"."tasks"
SET "source" = CASE
  WHEN "scheduled_for" IS NOT NULL THEN 'schedule'
  WHEN "workflow_id" IS NOT NULL THEN 'workflow'
  ELSE 'manual'
END
WHERE "source" IS NULL;--> statement-breakpoint
ALTER TABLE "goat"."tasks" ALTER COLUMN "source" SET DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD CONSTRAINT "goat_tasks_source_not_null"
  CHECK ("source" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."tasks" VALIDATE CONSTRAINT "goat_tasks_source_not_null";--> statement-breakpoint
ALTER TABLE "goat"."tasks" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."tasks" DROP CONSTRAINT "goat_tasks_source_not_null";--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD CONSTRAINT "goat_tasks_source_check"
  CHECK ("source" IN ('manual', 'workflow', 'schedule', 'agent')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."tasks" VALIDATE CONSTRAINT "goat_tasks_source_check";--> statement-breakpoint

CREATE TABLE "goat"."task_command_idempotency" (
	"command_id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"task_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"assistant_message_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"run_id" text NOT NULL,
	"transaction_id" bigint DEFAULT pg_current_xact_id()::xid::text::bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_task_command_idempotency_request_hash_check" CHECK ("goat"."task_command_idempotency"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "goat_task_command_idempotency_key_length_check" CHECK (length("goat"."task_command_idempotency"."idempotency_key") BETWEEN 1 AND 200)
);--> statement-breakpoint
ALTER TABLE "goat"."task_command_idempotency" ADD CONSTRAINT "task_command_idempotency_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_command_idempotency" ADD CONSTRAINT "task_command_idempotency_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_task_command_idempotency_actor_key_idx" ON "goat"."task_command_idempotency" USING btree ("user_workos_id","workspace_id","idempotency_key");--> statement-breakpoint

CREATE TABLE "goat"."task_read_model_v1" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"workspace_id" text,
	"display_id" text NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"conversation_id" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"engine" text NOT NULL,
	"model" text NOT NULL,
	"workflow_id" text,
	"schedule_id" text,
	"scheduled_for" timestamp with time zone,
	"result" text,
	"error" text,
	"reported_status" text,
	"outcome_comment" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "goat_task_read_model_v1_status_check" CHECK ("status" IN ('queued', 'running', 'waiting', 'blocked', 'succeeded', 'failed', 'canceled', 'archived')),
	CONSTRAINT "goat_task_read_model_v1_source_check" CHECK ("source" IN ('manual', 'workflow', 'schedule', 'agent')),
	CONSTRAINT "goat_task_read_model_v1_engine_check" CHECK ("engine" IN ('opencompany', 'codex', 'claude_code')),
	CONSTRAINT "goat_task_read_model_v1_reported_status_check" CHECK ("reported_status" IS NULL OR "reported_status" IN ('done', 'needs_attention'))
);--> statement-breakpoint
CREATE INDEX "goat_task_read_model_v1_workspace_archived_updated_idx" ON "goat"."task_read_model_v1" USING btree ("workspace_id","archived_at","updated_at");--> statement-breakpoint
CREATE INDEX "goat_task_read_model_v1_actor_archived_updated_idx" ON "goat"."task_read_model_v1" USING btree ("actor_id","archived_at","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_task_read_model_v1_conversation_idx" ON "goat"."task_read_model_v1" USING btree ("conversation_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."canonical_task_status_v1"(
  physical_status text,
  archived_at timestamptz
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN archived_at IS NOT NULL THEN 'archived'
    WHEN physical_status = 'queued' THEN 'queued'
    WHEN physical_status = 'running' THEN 'running'
    WHEN physical_status = 'succeeded' THEN 'succeeded'
    WHEN physical_status = 'failed' THEN 'failed'
    WHEN physical_status = 'canceled' THEN 'canceled'
    ELSE 'failed'
  END
$$;--> statement-breakpoint

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
    outcome_comment, archived_at, created_at, updated_at
  )
  SELECT
    task.id, task.user_workos_id, task.workspace_id, task.display_id, task.name, task.prompt,
    conversation.id, goat.canonical_task_status_v1(task.status, task.archived_at), task.source,
    conversation.engine, task.model, task.workflow_id, task.schedule_id, task.scheduled_for,
    task.result, task.error, task.reported_outcome, task.outcome_comment, task.archived_at,
    task.created_at, task.updated_at
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
    archived_at = EXCLUDED.archived_at,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."project_task_read_model_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM goat.refresh_task_read_model_v1(OLD.id);
    RETURN OLD;
  END IF;
  PERFORM goat.refresh_task_read_model_v1(NEW.id);
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "goat_project_task_read_model_v1"
AFTER INSERT OR UPDATE OR DELETE ON "goat"."tasks"
FOR EACH ROW EXECUTE FUNCTION "goat"."project_task_read_model_v1"();--> statement-breakpoint

-- Messages remain one canonical resource. Broaden the existing fixed Message projection to include
-- task-kind Conversations without adding a Task-specific message table or wire protocol.
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
    NEW.id, NEW.session_id, conversation.user_workos_id,
    COALESCE(runtime.workspace_id, task.workspace_id), NEW.role,
    NEW.content, NEW.task_id, goat.chat_presentation_v1(NEW.debug_trace),
    goat.chat_attachments_v1(NEW.attachments), NEW.created_at, NEW.updated_at
  FROM goat.chat_sessions AS conversation
  LEFT JOIN goat.tasks AS task ON task.session_id = conversation.id
  LEFT JOIN LATERAL (
    SELECT candidate.workspace_id
    FROM goat.codex_chat_sessions AS candidate
    WHERE candidate.chat_session_id = conversation.id
      AND candidate.user_workos_id = conversation.user_workos_id
    ORDER BY candidate.updated_at DESC, candidate.id DESC
    LIMIT 1
  ) AS runtime ON true
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

-- The Chat projection originally treated every non-chat Conversation as a deletion. Keep that
-- behavior for the frozen compatibility surface, but retain canonical Message/Run projections for
-- Task Conversations and scope them from the owning Task when a runtime is being created or removed.
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
      SELECT runtime.workspace_id
      FROM goat.codex_chat_sessions AS runtime
      WHERE runtime.chat_session_id = target_conversation_id
        AND runtime.user_workos_id = projection.actor_id
      ORDER BY runtime.updated_at DESC, runtime.id DESC
      LIMIT 1
    ),
    (
      SELECT task.workspace_id
      FROM goat.tasks AS task
      WHERE task.session_id = target_conversation_id
      LIMIT 1
    )
  )
  WHERE projection.conversation_id = target_conversation_id;

  UPDATE goat.run_read_model_v1 AS projection
  SET workspace_id = COALESCE(
    (
      SELECT runtime.workspace_id
      FROM goat.codex_chat_sessions AS runtime
      WHERE runtime.chat_session_id = target_conversation_id
        AND runtime.user_workos_id = projection.actor_id
      ORDER BY runtime.updated_at DESC, runtime.id DESC
      LIMIT 1
    ),
    (
      SELECT task.workspace_id
      FROM goat.tasks AS task
      WHERE task.session_id = target_conversation_id
      LIMIT 1
    )
  )
  WHERE projection.conversation_id = target_conversation_id;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

SELECT goat.refresh_task_read_model_v1(task.id)
FROM goat.tasks AS task
WHERE task.session_id IS NOT NULL;--> statement-breakpoint
INSERT INTO goat.message_read_model_v1 (
  id, conversation_id, actor_id, workspace_id, role, content, task_id, presentation,
  attachments, created_at, updated_at
)
SELECT
  message.id, message.session_id, conversation.user_workos_id,
  COALESCE(runtime.workspace_id, task.workspace_id),
  message.role, message.content, message.task_id, goat.chat_presentation_v1(message.debug_trace),
  goat.chat_attachments_v1(message.attachments), message.created_at, message.updated_at
FROM goat.chat_messages AS message
JOIN goat.chat_sessions AS conversation ON conversation.id = message.session_id
LEFT JOIN goat.tasks AS task ON task.session_id = conversation.id
LEFT JOIN LATERAL (
  SELECT candidate.workspace_id
  FROM goat.codex_chat_sessions AS candidate
  WHERE candidate.chat_session_id = conversation.id
    AND candidate.user_workos_id = conversation.user_workos_id
  ORDER BY candidate.updated_at DESC, candidate.id DESC
  LIMIT 1
) AS runtime ON true
WHERE conversation.kind = 'task'
ON CONFLICT (id) DO NOTHING;
