-- Retire the Local Codex bridge without deleting chat history. Local sessions
-- become normal Goat chats; bridge/runtime coordination state is no longer used.
UPDATE "goat"."chat_sessions"
SET
  "engine" = 'opencompany',
  "model" = 'moonshotai/kimi-k3',
  "updated_at" = now()
WHERE "engine" = 'local_codex';--> statement-breakpoint

ALTER TABLE "goat"."chat_sessions"
  DROP CONSTRAINT IF EXISTS "goat_chat_sessions_engine_check";--> statement-breakpoint
ALTER TABLE "goat"."chat_sessions"
  ADD CONSTRAINT "goat_chat_sessions_engine_check"
  CHECK ("goat"."chat_sessions"."engine" IN ('opencompany', 'codex', 'claude_code'));--> statement-breakpoint

DROP TABLE IF EXISTS "goat"."local_codex_events";--> statement-breakpoint
DROP TABLE IF EXISTS "goat"."local_codex_commands";--> statement-breakpoint
DROP TABLE IF EXISTS "goat"."local_codex_turns";--> statement-breakpoint
DROP TABLE IF EXISTS "goat"."local_codex_sessions";--> statement-breakpoint
DROP TABLE IF EXISTS "goat"."local_bridges";--> statement-breakpoint

ALTER TABLE "goat"."users"
  DROP COLUMN IF EXISTS "local_codex_beta_enabled";
