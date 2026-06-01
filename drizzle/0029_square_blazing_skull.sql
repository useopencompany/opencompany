CREATE TABLE "agent_schedule_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"trigger_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"session_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_schedule_runs_status_check" CHECK ("agent_schedule_runs"."status" IN ('pending', 'started', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "agent_schedule_runs" ADD CONSTRAINT "agent_schedule_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_schedule_runs" ADD CONSTRAINT "agent_schedule_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_schedule_runs" ADD CONSTRAINT "agent_schedule_runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_schedule_runs_workspace_idx" ON "agent_schedule_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_schedule_runs_agent_idx" ON "agent_schedule_runs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_schedule_runs_scheduled_for_idx" ON "agent_schedule_runs" USING btree ("scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_schedule_runs_idempotency_idx" ON "agent_schedule_runs" USING btree ("agent_id","trigger_id","scheduled_for");