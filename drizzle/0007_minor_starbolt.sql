ALTER TABLE "agent_sessions" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "sandbox_terminated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_sessions_visible_workspace_user_updated_idx" ON "agent_sessions" USING btree ("workspace_id","user_id","archived_at","updated_at");