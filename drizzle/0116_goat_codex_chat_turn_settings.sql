ALTER TABLE "goat"."local_codex_turns" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
