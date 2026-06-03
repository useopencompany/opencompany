CREATE TABLE "agent_session_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text,
	"tool_call_id" text NOT NULL,
	"questions" jsonb NOT NULL,
	"answers" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"answered_by_user_id" text,
	"resolution_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_questions_status_check" CHECK ("agent_session_questions"."status" IN ('pending', 'answered', 'cancelled')),
	CONSTRAINT "agent_session_questions_resolution_source_check" CHECK ("agent_session_questions"."resolution_source" IS NULL OR "agent_session_questions"."resolution_source" IN ('user', 'abort', 'timeout', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "agent_session_run_jobs" DROP CONSTRAINT "agent_session_run_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "agent_session_questions" ADD CONSTRAINT "agent_session_questions_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_questions" ADD CONSTRAINT "agent_session_questions_answered_by_user_id_users_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_questions_session_tool_call_idx" ON "agent_session_questions" USING btree ("session_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "agent_session_questions_session_status_idx" ON "agent_session_questions" USING btree ("session_id","status");--> statement-breakpoint
ALTER TABLE "agent_session_run_jobs" ADD CONSTRAINT "agent_session_run_jobs_kind_check" CHECK ("agent_session_run_jobs"."kind" IN ('start', 'message', 'title', 'after_session', 'resume_approval', 'resume_question'));