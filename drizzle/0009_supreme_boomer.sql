CREATE TABLE "agent_session_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text,
	"run_lease_id" text,
	"step_index" integer NOT NULL,
	"model_provider" text NOT NULL,
	"model_name" text NOT NULL,
	"response_id" text,
	"response_model_id" text,
	"finish_reason" text,
	"raw_finish_reason" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"input_no_cache_tokens" integer DEFAULT 0 NOT NULL,
	"input_cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"input_cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"output_text_tokens" integer DEFAULT 0 NOT NULL,
	"output_reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"raw_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_session_messages" ADD COLUMN "model_message" jsonb;--> statement-breakpoint
ALTER TABLE "agent_session_messages" ADD COLUMN "response_to_message_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "run_lease_owner" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "run_lease_message_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "run_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "run_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_session_usage" ADD CONSTRAINT "agent_session_usage_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_usage" ADD CONSTRAINT "agent_session_usage_message_id_agent_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."agent_session_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_session_usage_session_idx" ON "agent_session_usage" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_session_usage_message_idx" ON "agent_session_usage" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "agent_session_usage_session_created_at_idx" ON "agent_session_usage" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_messages_response_to_message_idx" ON "agent_session_messages" USING btree ("response_to_message_id");