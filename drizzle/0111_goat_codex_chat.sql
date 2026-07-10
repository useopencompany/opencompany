-- Cloud Codex chat engine: chat sessions can now run on a persistent cloud Codex
-- sandbox (engine 'codex'). Sessions/turns mirror the local_codex_* tables minus the
-- bridge coupling; turns double as the runner work queue (lease columns), and events
-- are a chunk-level audit log (deltas are never persisted).
ALTER TABLE "goat"."chat_sessions" DROP CONSTRAINT IF EXISTS "goat_chat_sessions_engine_check";--> statement-breakpoint
ALTER TABLE "goat"."chat_sessions" ADD CONSTRAINT "goat_chat_sessions_engine_check" CHECK ("goat"."chat_sessions"."engine" IN ('opencompany', 'local_codex', 'codex'));--> statement-breakpoint
CREATE TABLE "goat"."codex_chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"chat_session_id" text NOT NULL,
	"model" text DEFAULT 'gpt-5.5' NOT NULL,
	"sandbox_id" text,
	"codex_thread_id" text,
	"active_turn_id" text,
	"status" text DEFAULT 'starting' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_codex_chat_sessions_status_check" CHECK ("goat"."codex_chat_sessions"."status" IN ('starting', 'idle', 'running', 'failed', 'interrupted', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "goat"."codex_chat_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"codex_chat_session_id" text NOT NULL,
	"chat_session_id" text NOT NULL,
	"user_message_id" text NOT NULL,
	"assistant_message_id" text NOT NULL,
	"codex_turn_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"prompt" text NOT NULL,
	"error" text,
	"interrupt_requested_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_codex_chat_turns_status_check" CHECK ("goat"."codex_chat_turns"."status" IN ('queued', 'running', 'completed', 'failed', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "goat"."codex_chat_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"codex_chat_session_id" text NOT NULL,
	"codex_chat_turn_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_event" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_codex_chat_events_type_check" CHECK ("goat"."codex_chat_events"."type" IN ('assistant.completed', 'reasoning.completed', 'command.started', 'command.completed', 'command.failed', 'turn.started', 'turn.completed', 'usage.updated', 'error', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" ADD CONSTRAINT "codex_chat_sessions_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" ADD CONSTRAINT "codex_chat_sessions_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns" ADD CONSTRAINT "codex_chat_turns_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns" ADD CONSTRAINT "codex_chat_turns_codex_chat_session_id_codex_chat_sessions_id_fk" FOREIGN KEY ("codex_chat_session_id") REFERENCES "goat"."codex_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns" ADD CONSTRAINT "codex_chat_turns_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns" ADD CONSTRAINT "codex_chat_turns_user_message_id_chat_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "goat"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns" ADD CONSTRAINT "codex_chat_turns_assistant_message_id_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "goat"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_events" ADD CONSTRAINT "codex_chat_events_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_events" ADD CONSTRAINT "codex_chat_events_codex_chat_session_id_codex_chat_sessions_id_fk" FOREIGN KEY ("codex_chat_session_id") REFERENCES "goat"."codex_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_events" ADD CONSTRAINT "codex_chat_events_codex_chat_turn_id_codex_chat_turns_id_fk" FOREIGN KEY ("codex_chat_turn_id") REFERENCES "goat"."codex_chat_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_codex_chat_sessions_chat_session_idx" ON "goat"."codex_chat_sessions" USING btree ("chat_session_id");--> statement-breakpoint
CREATE INDEX "goat_codex_chat_sessions_user_updated_idx" ON "goat"."codex_chat_sessions" USING btree ("user_workos_id","updated_at");--> statement-breakpoint
CREATE INDEX "goat_codex_chat_turns_claim_idx" ON "goat"."codex_chat_turns" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "goat_codex_chat_turns_session_created_idx" ON "goat"."codex_chat_turns" USING btree ("codex_chat_session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_codex_chat_turns_assistant_message_idx" ON "goat"."codex_chat_turns" USING btree ("assistant_message_id");--> statement-breakpoint
CREATE INDEX "goat_codex_chat_events_session_created_idx" ON "goat"."codex_chat_events" USING btree ("codex_chat_session_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_codex_chat_events_turn_created_idx" ON "goat"."codex_chat_events" USING btree ("codex_chat_turn_id","created_at");
