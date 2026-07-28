-- Distinguish a retry that has only attempted sandbox acquisition from a
-- reclaimed turn that may already have invoked Codex. Existing running turns
-- are conservatively treated as having crossed the boundary during rollout.
ALTER TABLE "goat"."codex_chat_turns" ADD COLUMN "engine_recovery_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns" ADD COLUMN "engine_turn_baseline_ids" jsonb;--> statement-breakpoint
UPDATE "goat"."codex_chat_turns"
SET "engine_recovery_required" = true
WHERE "status" = 'running';
