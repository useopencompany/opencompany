-- Canonical approval continuations pause the stable Run between worker Attempts. The physical
-- durable-turn table remains in place; only its additive state vocabulary changes.
ALTER TABLE "goat"."codex_chat_turns" ADD CONSTRAINT "goat_codex_chat_turns_status_v2_check" CHECK ("goat"."codex_chat_turns"."status" IN ('queued', 'running', 'paused', 'completed', 'failed', 'interrupted')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns" VALIDATE CONSTRAINT "goat_codex_chat_turns_status_v2_check";--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns" DROP CONSTRAINT IF EXISTS "goat_codex_chat_turns_status_check";
