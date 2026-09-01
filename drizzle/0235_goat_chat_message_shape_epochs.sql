-- A Conversation's Electric Message shape log grows on every projected row rewrite. Track the
-- approximate bytes written since the last rotation, then advance a server-owned epoch only after
-- the active Run settles. Binding this epoch into the Shape definition gives the next subscriber a
-- fresh snapshot without interrupting the streaming turn that produced the writes.
ALTER TABLE "goat"."conversation_read_model_v1"
ADD COLUMN "message_shape_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."conversation_read_model_v1"
ADD COLUMN "message_shape_bytes_since_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."conversation_read_model_v1"
ADD CONSTRAINT "opencompany_conversation_read_model_v1_message_shape_epoch_check"
CHECK ("goat"."conversation_read_model_v1"."message_shape_epoch" >= 0);--> statement-breakpoint
ALTER TABLE "goat"."conversation_read_model_v1"
ADD CONSTRAINT "opencompany_conversation_read_model_v1_message_shape_bytes_check"
CHECK ("goat"."conversation_read_model_v1"."message_shape_bytes_since_epoch" >= 0);--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."opencompany_account_message_shape_bytes_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_conversation_id text;
  projected_row_bytes bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  target_conversation_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.conversation_id
    ELSE NEW.conversation_id
  END;
  projected_row_bytes := CASE
    WHEN TG_OP = 'DELETE' THEN pg_column_size(to_jsonb(OLD))::bigint
    ELSE pg_column_size(to_jsonb(NEW))::bigint
  END;

  UPDATE goat.conversation_read_model_v1 AS conversation
  SET message_shape_bytes_since_epoch =
    conversation.message_shape_bytes_since_epoch + projected_row_bytes
  WHERE conversation.id = target_conversation_id;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "opencompany_account_message_shape_bytes_v1"
AFTER INSERT OR UPDATE OR DELETE ON "goat"."message_read_model_v1"
FOR EACH ROW EXECUTE FUNCTION "goat"."opencompany_account_message_shape_bytes_v1"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."opencompany_rotate_message_shape_epoch_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The 16 MiB budget is intentionally based on projected row size rather than operation count:
  -- repeated rewrites of a large assistant row should rotate sooner than tiny transcript edits.
  IF NEW.status IN ('completed', 'failed', 'interrupted')
     AND OLD.status NOT IN ('completed', 'failed', 'interrupted') THEN
    UPDATE goat.conversation_read_model_v1 AS conversation
    SET message_shape_epoch = conversation.message_shape_epoch + 1,
        message_shape_bytes_since_epoch = 0
    WHERE conversation.id = NEW.chat_session_id
      AND conversation.message_shape_bytes_since_epoch >= 16 * 1024 * 1024;
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "opencompany_rotate_message_shape_epoch_v1"
AFTER UPDATE OF "status" ON "goat"."codex_chat_turns"
FOR EACH ROW EXECUTE FUNCTION "goat"."opencompany_rotate_message_shape_epoch_v1"();
