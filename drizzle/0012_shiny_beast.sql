CREATE TABLE "agent_session_tool_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text,
	"run_lease_id" text,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"provider_request_id" text,
	"cost_usd_micros" integer DEFAULT 0 NOT NULL,
	"raw_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_session_tool_usage" ADD CONSTRAINT "agent_session_tool_usage_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_tool_usage" ADD CONSTRAINT "agent_session_tool_usage_message_id_agent_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."agent_session_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_session_tool_usage_session_idx" ON "agent_session_tool_usage" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_session_tool_usage_message_idx" ON "agent_session_tool_usage" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "agent_session_tool_usage_session_created_at_idx" ON "agent_session_tool_usage" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_session_tool_usage_tool_call_idx" ON "agent_session_tool_usage" USING btree ("tool_call_id");