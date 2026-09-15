-- Steering: a queued coding turn can be promoted into the turn that is already running, so its
-- prompt is injected into that live turn instead of waiting for it to finish.
--
-- `steer_into_run_id` records the promotion as intent only. The promoted turn stays 'queued' and
-- claimable until the running worker actually injects it, so a turn that ends first just runs the
-- message next; nothing is stranded. Reversible: dropping the column returns every promoted turn
-- to an ordinary queued turn.
ALTER TABLE "goat"."codex_chat_turns"
	ADD COLUMN IF NOT EXISTS "steer_into_run_id" text;
--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns"
	DROP CONSTRAINT IF EXISTS "codex_chat_turns_steer_into_run_id_codex_chat_turns_id_fk";
--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns"
	ADD CONSTRAINT "codex_chat_turns_steer_into_run_id_codex_chat_turns_id_fk"
	FOREIGN KEY ("steer_into_run_id") REFERENCES "goat"."codex_chat_turns"("id") ON DELETE set null;
--> statement-breakpoint
-- The running worker polls for turns promoted into it; only queued rows can still be injected.
CREATE INDEX IF NOT EXISTS "goat_codex_chat_turns_steer_into_run_idx"
	ON "goat"."codex_chat_turns" ("steer_into_run_id", "created_at")
	WHERE "steer_into_run_id" IS NOT NULL AND "status" = 'queued';
