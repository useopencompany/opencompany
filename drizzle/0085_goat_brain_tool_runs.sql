CREATE TABLE "goat"."brain_tool_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"chat_session_id" text,
	"user_message_id" text,
	"assistant_message_id" text,
	"tool_call_id" text,
	"source_ref" text,
	"action" text,
	"ok" boolean DEFAULT false NOT NULL,
	"exit_code" integer,
	"duration_ms" integer,
	"trace_path" text,
	"trace" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."brain_tool_runs" ADD CONSTRAINT "brain_tool_runs_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_tool_runs" ADD CONSTRAINT "brain_tool_runs_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_tool_runs" ADD CONSTRAINT "brain_tool_runs_user_message_id_chat_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "goat"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_tool_runs" ADD CONSTRAINT "brain_tool_runs_assistant_message_id_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "goat"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_brain_tool_runs_user_created_at_idx" ON "goat"."brain_tool_runs" USING btree ("user_workos_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_brain_tool_runs_chat_session_created_at_idx" ON "goat"."brain_tool_runs" USING btree ("chat_session_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_brain_tool_runs_user_message_idx" ON "goat"."brain_tool_runs" USING btree ("user_message_id");--> statement-breakpoint
CREATE INDEX "goat_brain_tool_runs_tool_call_idx" ON "goat"."brain_tool_runs" USING btree ("tool_call_id");--> statement-breakpoint
CREATE INDEX "goat_brain_tool_runs_source_ref_idx" ON "goat"."brain_tool_runs" USING btree ("source_ref");
