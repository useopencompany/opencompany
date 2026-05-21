CREATE TABLE "agent_session_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_session_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"tool_name" text,
	"tool_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"title" text DEFAULT 'Untitled session' NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"model_provider" text DEFAULT 'vercel-ai-gateway' NOT NULL,
	"model_name" text DEFAULT 'openai/gpt-5.4-mini' NOT NULL,
	"e2b_sandbox_id" text,
	"workdir" text DEFAULT '/home/user/workspace' NOT NULL,
	"run_lease_id" text,
	"abort_requested_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_session_events" ADD CONSTRAINT "agent_session_events_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_events" ADD CONSTRAINT "agent_session_events_message_id_agent_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."agent_session_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_messages" ADD CONSTRAINT "agent_session_messages_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_session_events_session_idx" ON "agent_session_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_session_events_session_event_idx" ON "agent_session_events" USING btree ("session_id","id");--> statement-breakpoint
CREATE INDEX "agent_session_messages_session_idx" ON "agent_session_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_session_messages_session_created_at_idx" ON "agent_session_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_sessions_workspace_idx" ON "agent_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_agent_idx" ON "agent_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_status_idx" ON "agent_sessions" USING btree ("status");