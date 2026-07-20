-- Distinguish turns waiting for runner capacity from turns whose sandbox is
-- starting, so the Cloud Codex UI can report queueing accurately.
ALTER TABLE "goat"."codex_chat_sessions" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" DROP CONSTRAINT IF EXISTS "goat_codex_chat_sessions_status_check";--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" ADD CONSTRAINT "goat_codex_chat_sessions_status_check" CHECK ("codex_chat_sessions"."status" IN ('queued', 'starting', 'idle', 'running', 'failed', 'interrupted', 'closed'));
