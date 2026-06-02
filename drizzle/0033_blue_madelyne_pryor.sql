CREATE TABLE "agent_tool_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"provider_key" text NOT NULL,
	"permission_group" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input_preview" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" text,
	"decision_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tool_approvals_status_check" CHECK ("agent_tool_approvals"."status" IN ('pending', 'approved', 'denied'))
);
--> statement-breakpoint
CREATE TABLE "workspace_tool_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_key" text NOT NULL,
	"permission_group" text NOT NULL,
	"decision" text NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_tool_policies_group_check" CHECK ("workspace_tool_policies"."permission_group" IN ('read', 'post', 'modify', 'admin')),
	CONSTRAINT "workspace_tool_policies_decision_check" CHECK ("workspace_tool_policies"."decision" IN ('allow', 'ask', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "agent_session_run_jobs" DROP CONSTRAINT "agent_session_run_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "agent_session_run_jobs" DROP CONSTRAINT "agent_session_run_jobs_message_id_agent_session_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_tool_approvals" ADD CONSTRAINT "agent_tool_approvals_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_approvals" ADD CONSTRAINT "agent_tool_approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tool_policies" ADD CONSTRAINT "workspace_tool_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tool_policies" ADD CONSTRAINT "workspace_tool_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tool_approvals_session_tool_call_idx" ON "agent_tool_approvals" USING btree ("session_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "agent_tool_approvals_session_status_idx" ON "agent_tool_approvals" USING btree ("session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_tool_policies_ws_provider_group_idx" ON "workspace_tool_policies" USING btree ("workspace_id","provider_key","permission_group");--> statement-breakpoint
CREATE INDEX "workspace_tool_policies_workspace_idx" ON "workspace_tool_policies" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "agent_session_run_jobs" ADD CONSTRAINT "agent_session_run_jobs_kind_check" CHECK ("agent_session_run_jobs"."kind" IN ('start', 'message', 'title', 'after_session', 'resume_approval'));