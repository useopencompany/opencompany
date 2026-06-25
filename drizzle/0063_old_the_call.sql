ALTER TABLE "agent_session_run_jobs" DROP CONSTRAINT "agent_session_run_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "config" SET DEFAULT '{"schemaVersion":"agent.v1","title":"Untitled agent","instructions":"","engine":"opencompany","model":{"provider":"vercel-ai-gateway","name":"openai/gpt-5.4-mini"},"tools":[],"brain":[],"agents":[],"integrations":{"github":{"repositories":[]}},"triggers":[]}'::jsonb;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "engine" text DEFAULT 'opencompany' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "engine_session_id" text;--> statement-breakpoint
CREATE INDEX "agent_sessions_engine_idx" ON "agent_sessions" USING btree ("engine");--> statement-breakpoint
ALTER TABLE "agent_session_run_jobs" ADD CONSTRAINT "agent_session_run_jobs_kind_check" CHECK ("agent_session_run_jobs"."kind" IN ('start', 'message', 'codex_turn', 'title', 'after_session', 'resume_approval', 'resume_question'));--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_engine_check" CHECK ("agent_sessions"."engine" IN ('opencompany', 'codex'));