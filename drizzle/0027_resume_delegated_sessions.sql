ALTER TABLE "agents" ALTER COLUMN "config" SET DEFAULT '{"schemaVersion":"agent.v1","title":"Untitled agent","instructions":"","model":{"provider":"vercel-ai-gateway","name":"openai/gpt-5.4-mini"},"tools":[],"brain":[],"agents":[],"integrations":{"github":{"repositories":[]}},"triggers":[]}'::jsonb;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "parent_session_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "parent_message_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "parent_tool_call_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_parent_session_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_parent_session_idx" ON "agent_sessions" USING btree ("parent_session_id");
