ALTER TABLE "agent_sessions" ADD COLUMN "last_turn_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "last_seen_at" timestamp with time zone;