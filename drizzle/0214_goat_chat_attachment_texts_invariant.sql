CREATE FUNCTION "goat"."normalize_chat_message_attachment_texts"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."attachment_texts" IS NOT NULL
     AND jsonb_typeof(NEW."attachment_texts") = 'null' THEN
    NEW."attachment_texts" := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "chat_messages_normalize_attachment_texts"
BEFORE INSERT OR UPDATE OF "attachment_texts" ON "goat"."chat_messages"
FOR EACH ROW
EXECUTE FUNCTION "goat"."normalize_chat_message_attachment_texts"();--> statement-breakpoint
UPDATE "goat"."chat_messages"
SET "attachment_texts" = NULL
WHERE jsonb_typeof("attachment_texts") = 'null';--> statement-breakpoint
ALTER TABLE "goat"."chat_messages"
ADD CONSTRAINT "chat_messages_attachment_texts_object_check"
CHECK (
  "goat"."chat_messages"."attachment_texts" IS NULL
  OR jsonb_typeof("goat"."chat_messages"."attachment_texts") = 'object'
) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."chat_messages"
VALIDATE CONSTRAINT "chat_messages_attachment_texts_object_check";
