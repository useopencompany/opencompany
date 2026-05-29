ALTER TABLE "agent_sessions" ADD COLUMN "source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_sessions_parent_workspace_user_idx" ON "agent_sessions" USING btree ("parent_session_id","workspace_id","user_id","archived_at","updated_at");--> statement-breakpoint
CREATE INDEX "agent_sessions_source_idx" ON "agent_sessions" USING btree ("source");--> statement-breakpoint
CREATE INDEX "agent_sessions_visible_workspace_user_source_updated_idx" ON "agent_sessions" USING btree ("workspace_id","user_id","source","archived_at","updated_at");--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_source_check" CHECK ("agent_sessions"."source" IN ('user', 'agent'));