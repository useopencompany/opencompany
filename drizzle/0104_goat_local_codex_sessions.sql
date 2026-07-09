ALTER TABLE "goat"."chat_sessions" ADD COLUMN "engine" text DEFAULT 'opencompany' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."chat_sessions" ADD CONSTRAINT "goat_chat_sessions_engine_check" CHECK ("goat"."chat_sessions"."engine" IN ('opencompany', 'local_codex'));--> statement-breakpoint
CREATE TABLE "goat"."local_bridges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goat"."local_codex_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"chat_session_id" text NOT NULL,
	"bridge_id" text,
	"repository_path" text NOT NULL,
	"worktree_path" text,
	"model" text DEFAULT 'gpt-5.5' NOT NULL,
	"codex_thread_id" text,
	"active_turn_id" text,
	"status" text DEFAULT 'starting' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_local_codex_sessions_status_check" CHECK ("goat"."local_codex_sessions"."status" IN ('starting', 'idle', 'running', 'failed', 'interrupted', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "goat"."local_codex_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"local_codex_session_id" text NOT NULL,
	"user_message_id" text NOT NULL,
	"assistant_message_id" text NOT NULL,
	"codex_turn_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"prompt" text NOT NULL,
	"error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_local_codex_turns_status_check" CHECK ("goat"."local_codex_turns"."status" IN ('queued', 'running', 'completed', 'failed', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "goat"."local_codex_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"local_codex_session_id" text NOT NULL,
	"local_codex_turn_id" text,
	"bridge_id" text,
	"claimed_by_bridge_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_local_codex_commands_status_check" CHECK ("goat"."local_codex_commands"."status" IN ('queued', 'claimed', 'succeeded', 'failed')),
	CONSTRAINT "goat_local_codex_commands_kind_check" CHECK ("goat"."local_codex_commands"."kind" IN ('start_turn', 'steer', 'interrupt', 'close'))
);
--> statement-breakpoint
CREATE TABLE "goat"."local_codex_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"local_codex_session_id" text NOT NULL,
	"local_codex_turn_id" text,
	"bridge_id" text,
	"command_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_event" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_local_codex_events_type_check" CHECK ("goat"."local_codex_events"."type" IN ('assistant.delta', 'assistant.completed', 'reasoning.completed', 'command.started', 'command.output', 'command.completed', 'command.failed', 'turn.started', 'turn.completed', 'usage.updated', 'error', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "goat"."local_bridges" ADD CONSTRAINT "local_bridges_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_sessions" ADD CONSTRAINT "local_codex_sessions_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_sessions" ADD CONSTRAINT "local_codex_sessions_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_sessions" ADD CONSTRAINT "local_codex_sessions_bridge_id_local_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "goat"."local_bridges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_turns" ADD CONSTRAINT "local_codex_turns_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_turns" ADD CONSTRAINT "local_codex_turns_local_codex_session_id_local_codex_sessions_id_fk" FOREIGN KEY ("local_codex_session_id") REFERENCES "goat"."local_codex_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_turns" ADD CONSTRAINT "local_codex_turns_user_message_id_chat_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "goat"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_turns" ADD CONSTRAINT "local_codex_turns_assistant_message_id_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "goat"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_commands" ADD CONSTRAINT "local_codex_commands_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_commands" ADD CONSTRAINT "local_codex_commands_local_codex_session_id_local_codex_sessions_id_fk" FOREIGN KEY ("local_codex_session_id") REFERENCES "goat"."local_codex_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_commands" ADD CONSTRAINT "local_codex_commands_local_codex_turn_id_local_codex_turns_id_fk" FOREIGN KEY ("local_codex_turn_id") REFERENCES "goat"."local_codex_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_commands" ADD CONSTRAINT "local_codex_commands_bridge_id_local_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "goat"."local_bridges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_commands" ADD CONSTRAINT "local_codex_commands_claimed_by_bridge_id_local_bridges_id_fk" FOREIGN KEY ("claimed_by_bridge_id") REFERENCES "goat"."local_bridges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_events" ADD CONSTRAINT "local_codex_events_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_events" ADD CONSTRAINT "local_codex_events_local_codex_session_id_local_codex_sessions_id_fk" FOREIGN KEY ("local_codex_session_id") REFERENCES "goat"."local_codex_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_events" ADD CONSTRAINT "local_codex_events_local_codex_turn_id_local_codex_turns_id_fk" FOREIGN KEY ("local_codex_turn_id") REFERENCES "goat"."local_codex_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_events" ADD CONSTRAINT "local_codex_events_bridge_id_local_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "goat"."local_bridges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."local_codex_events" ADD CONSTRAINT "local_codex_events_command_id_local_codex_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "goat"."local_codex_commands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_local_bridges_user_last_seen_idx" ON "goat"."local_bridges" USING btree ("user_workos_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_local_bridges_token_hash_idx" ON "goat"."local_bridges" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_local_codex_sessions_chat_session_idx" ON "goat"."local_codex_sessions" USING btree ("chat_session_id");--> statement-breakpoint
CREATE INDEX "goat_local_codex_sessions_user_updated_idx" ON "goat"."local_codex_sessions" USING btree ("user_workos_id","updated_at");--> statement-breakpoint
CREATE INDEX "goat_local_codex_sessions_bridge_idx" ON "goat"."local_codex_sessions" USING btree ("bridge_id");--> statement-breakpoint
CREATE INDEX "goat_local_codex_turns_session_created_idx" ON "goat"."local_codex_turns" USING btree ("local_codex_session_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_local_codex_turns_user_created_idx" ON "goat"."local_codex_turns" USING btree ("user_workos_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_local_codex_turns_assistant_message_idx" ON "goat"."local_codex_turns" USING btree ("assistant_message_id");--> statement-breakpoint
CREATE INDEX "goat_local_codex_commands_bridge_queued_idx" ON "goat"."local_codex_commands" USING btree ("bridge_id","status","created_at");--> statement-breakpoint
CREATE INDEX "goat_local_codex_commands_session_created_idx" ON "goat"."local_codex_commands" USING btree ("local_codex_session_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_local_codex_events_session_created_idx" ON "goat"."local_codex_events" USING btree ("local_codex_session_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_local_codex_events_turn_created_idx" ON "goat"."local_codex_events" USING btree ("local_codex_turn_id","created_at");
