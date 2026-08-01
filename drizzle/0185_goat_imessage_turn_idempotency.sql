ALTER TABLE "goat"."imessage_sends"
  ADD COLUMN IF NOT EXISTS "turn_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_imessage_sends_turn_sent_idx"
  ON "goat"."imessage_sends" ("turn_id")
  WHERE "turn_id" IS NOT NULL AND "status" = 'sent';
