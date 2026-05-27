CREATE TABLE "agent_session_run_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"lease_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_session_run_jobs" ADD CONSTRAINT "agent_session_run_jobs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_run_jobs" ADD CONSTRAINT "agent_session_run_jobs_message_id_agent_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."agent_session_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_run_jobs_idempotency_idx" ON "agent_session_run_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_session_run_jobs_session_idx" ON "agent_session_run_jobs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_session_run_jobs_status_next_run_at_idx" ON "agent_session_run_jobs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "agent_session_run_jobs_lease_expires_at_idx" ON "agent_session_run_jobs" USING btree ("lease_expires_at");