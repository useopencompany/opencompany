-- Shipped to prod as 0044_omniscient_dazzler before this branch's migrations were
-- sequenced in front of it; IF NOT EXISTS so the re-numbered entry no-ops where it
-- already ran.
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "last_turn_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
