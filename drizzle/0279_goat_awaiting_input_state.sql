-- A run blocked on the reader, projected for the Conversation read model. Tasks carry the same
-- flag through their own projection in 0280: one predicate, one trigger per read model, matching
-- how every other projection here is wired.
ALTER TABLE "goat"."conversation_read_model_v1" ADD COLUMN "awaiting_input" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- One definition of "this conversation is blocked on the reader", shared by both projections.
-- A pending approval is the canonical record of it: the connected-action "Ask" pause, the coding
-- engine's permission prompt, and an engine question all land in goat.run_approvals as 'pending'
-- and all clear the same way.
--
-- The run-level conditions mirror the ones resolveApproval authorizes against, so the flag only
-- stands while the request can still be answered. A run that died with approvals outstanding
-- leaves them 'pending' forever -- forceFailClaimedTurn fails a running turn without touching
-- goat.run_approvals, and turn-end cancellation only covers 'acp_permission' -- and a row that
-- claimed to be waiting on a decision nobody can make would pin itself to the sidebar and the
-- review queue with no way to clear it.
CREATE OR REPLACE FUNCTION "goat"."conversation_awaiting_input_v1"(target_conversation_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM goat.run_approvals AS approval
    JOIN goat.codex_chat_turns AS run ON run.id = approval.run_id
    WHERE run.chat_session_id = target_conversation_id
      AND approval.status = 'pending'
      AND run.status IN ('running', 'paused', 'queued', 'completed')
      AND run.interrupt_requested_at IS NULL
  )
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."refresh_conversation_read_model_v1"(target_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  source_kind text;
BEGIN
  SELECT kind INTO source_kind FROM goat.chat_sessions WHERE id = target_id;

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
    last_seen_at, activity_state, has_unseen, awaiting_input, runtime_status, active_run_id,
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
    source.has_unseen, goat.conversation_awaiting_input_v1(source.id),
    runtime.status, runtime.active_turn_id,
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
    awaiting_input = EXCLUDED.awaiting_input,
    runtime_status = EXCLUDED.runtime_status,
    active_run_id = EXCLUDED.active_run_id,
    runtime_has_error = EXCLUDED.runtime_has_error,
    runtime_updated_at = EXCLUDED.runtime_updated_at,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at;
END
$$;--> statement-breakpoint

-- Raising an approval touches the conversation, but resolving one only touches the run, the
-- runtime, and the Task. Without this the flag would latch on and never clear, so the approval
-- table drives its own projection refresh on both edges.
CREATE OR REPLACE FUNCTION "goat"."project_run_approval_conversation_read_model_v1"()
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
    PERFORM goat.refresh_conversation_read_model_v1(target_conversation_id);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "goat_project_run_approval_conversation_read_model_v1" ON "goat"."run_approvals";--> statement-breakpoint
CREATE TRIGGER "goat_project_run_approval_conversation_read_model_v1"
AFTER INSERT OR UPDATE OF "status" OR DELETE ON "goat"."run_approvals"
FOR EACH ROW EXECUTE FUNCTION "goat"."project_run_approval_conversation_read_model_v1"();--> statement-breakpoint

-- The flag reads the run's status as well as the approval's, so the run has to refresh it too:
-- a turn that ends with approvals outstanding stops being answerable without anything writing to
-- goat.run_approvals. Narrower than the run projection trigger beside it, which already fires on
-- every event-sequence bump.
CREATE OR REPLACE FUNCTION "goat"."project_run_status_conversation_read_model_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.chat_session_id IS NOT NULL THEN
    PERFORM goat.refresh_conversation_read_model_v1(NEW.chat_session_id);
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "goat_project_run_status_conversation_read_model_v1" ON "goat"."codex_chat_turns";--> statement-breakpoint
CREATE TRIGGER "goat_project_run_status_conversation_read_model_v1"
AFTER UPDATE OF "status", "interrupt_requested_at" ON "goat"."codex_chat_turns"
FOR EACH ROW
WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  OR OLD.interrupt_requested_at IS DISTINCT FROM NEW.interrupt_requested_at
)
EXECUTE FUNCTION "goat"."project_run_status_conversation_read_model_v1"();--> statement-breakpoint

UPDATE goat.conversation_read_model_v1 AS projection
SET awaiting_input = true
WHERE goat.conversation_awaiting_input_v1(projection.id);
