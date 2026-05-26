CREATE TABLE "agent_session_after_session_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"last_user_message_id" text NOT NULL,
	"agent_version" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_lease_id" text,
	"skipped_reason" text,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_session_messages" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_session_after_session_runs" ADD CONSTRAINT "agent_session_after_session_runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_after_session_runs" ADD CONSTRAINT "agent_session_after_session_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_after_session_runs" ADD CONSTRAINT "agent_session_after_session_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_after_session_runs" ADD CONSTRAINT "agent_session_after_session_runs_last_user_message_id_agent_session_messages_id_fk" FOREIGN KEY ("last_user_message_id") REFERENCES "public"."agent_session_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_session_after_session_runs_session_idx" ON "agent_session_after_session_runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_session_after_session_runs_workspace_idx" ON "agent_session_after_session_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_after_session_runs_idempotency_idx" ON "agent_session_after_session_runs" USING btree ("session_id","last_user_message_id","agent_version");