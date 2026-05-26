ALTER TABLE "agent_session_amp_artifacts" ADD COLUMN IF NOT EXISTS "amp_thread_id" text;--> statement-breakpoint
ALTER TABLE "agent_session_amp_artifacts" ADD COLUMN IF NOT EXISTS "continued_from_amp_thread_id" text;
