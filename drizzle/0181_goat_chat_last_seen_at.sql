ALTER TABLE "goat"."chat_sessions" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;--> statement-breakpoint
UPDATE "goat"."chat_sessions" SET "last_seen_at" = "updated_at" WHERE "kind" = 'chat' AND "last_seen_at" IS NULL;
