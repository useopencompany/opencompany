-- Additive persistence foundation for canonical Chat Runs. Existing chat and durable runner rows
-- remain in place; the repository adapter is the only layer that maps these physical names to the
-- versioned protocol.
ALTER TABLE "goat"."codex_chat_turns" ADD COLUMN "event_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns" ADD CONSTRAINT "goat_codex_chat_turns_event_sequence_check" CHECK ("goat"."codex_chat_turns"."event_sequence" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns" VALIDATE CONSTRAINT "goat_codex_chat_turns_event_sequence_check";--> statement-breakpoint

CREATE TABLE "goat"."chat_command_idempotency" (
	"command_id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"assistant_message_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"run_id" text NOT NULL,
	"transaction_id" bigint DEFAULT pg_current_xact_id()::xid::text::bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_chat_command_idempotency_request_hash_check" CHECK ("goat"."chat_command_idempotency"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "goat_chat_command_idempotency_key_length_check" CHECK (length("goat"."chat_command_idempotency"."idempotency_key") BETWEEN 1 AND 200)
);--> statement-breakpoint

CREATE TABLE "goat"."run_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"number" integer NOT NULL,
	"status" text NOT NULL,
	"worker_id" text NOT NULL,
	"lease_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_run_attempts_status_check" CHECK ("goat"."run_attempts"."status" IN ('running', 'completed', 'failed', 'canceled', 'abandoned')),
	CONSTRAINT "goat_run_attempts_number_check" CHECK ("goat"."run_attempts"."number" > 0)
);--> statement-breakpoint

CREATE TABLE "goat"."run_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text,
	"kind" text NOT NULL,
	"prompt" text NOT NULL,
	"options" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolution" text,
	"response" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_run_approvals_status_check" CHECK ("goat"."run_approvals"."status" IN ('pending', 'resolved', 'canceled')),
	CONSTRAINT "goat_run_approvals_resolution_check" CHECK ("goat"."run_approvals"."resolution" IS NULL OR "goat"."run_approvals"."resolution" IN ('approved', 'denied', 'answered', 'canceled')),
	CONSTRAINT "goat_run_approvals_lifecycle_check" CHECK (("goat"."run_approvals"."status" = 'pending' AND "goat"."run_approvals"."resolution" IS NULL AND "goat"."run_approvals"."resolved_at" IS NULL) OR ("goat"."run_approvals"."status" IN ('resolved', 'canceled') AND "goat"."run_approvals"."resolution" IS NOT NULL AND "goat"."run_approvals"."resolved_at" IS NOT NULL))
);--> statement-breakpoint

CREATE TABLE "goat"."run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text,
	"sequence" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_run_events_type_check" CHECK ("goat"."run_events"."type" IN ('run.queued', 'run.started', 'run.cancel_requested', 'message.created', 'message.content_updated', 'tool.started', 'tool.completed', 'tool.failed', 'approval.requested', 'approval.resolved', 'artifact.published', 'run.paused', 'run.completed', 'run.failed', 'run.canceled')),
	CONSTRAINT "goat_run_events_sequence_check" CHECK ("goat"."run_events"."sequence" > 0),
	CONSTRAINT "goat_run_events_schema_version_check" CHECK ("goat"."run_events"."schema_version" = 1)
);--> statement-breakpoint

ALTER TABLE "goat"."chat_command_idempotency" ADD CONSTRAINT "chat_command_idempotency_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."chat_command_idempotency" ADD CONSTRAINT "chat_command_idempotency_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."run_attempts" ADD CONSTRAINT "run_attempts_run_id_codex_chat_turns_id_fk" FOREIGN KEY ("run_id") REFERENCES "goat"."codex_chat_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."run_approvals" ADD CONSTRAINT "run_approvals_run_id_codex_chat_turns_id_fk" FOREIGN KEY ("run_id") REFERENCES "goat"."codex_chat_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."run_approvals" ADD CONSTRAINT "run_approvals_attempt_id_run_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "goat"."run_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."run_events" ADD CONSTRAINT "run_events_run_id_codex_chat_turns_id_fk" FOREIGN KEY ("run_id") REFERENCES "goat"."codex_chat_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."run_events" ADD CONSTRAINT "run_events_attempt_id_run_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "goat"."run_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "goat_chat_command_idempotency_actor_key_idx" ON "goat"."chat_command_idempotency" USING btree ("user_workos_id","workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_run_attempts_run_number_idx" ON "goat"."run_attempts" USING btree ("run_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_run_attempts_lease_idx" ON "goat"."run_attempts" USING btree ("lease_id") WHERE "lease_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "goat_run_approvals_run_status_created_idx" ON "goat"."run_approvals" USING btree ("run_id","status","created_at");--> statement-breakpoint
CREATE INDEX "goat_run_approvals_attempt_idx" ON "goat"."run_approvals" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_run_events_run_sequence_idx" ON "goat"."run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "goat_run_events_attempt_idx" ON "goat"."run_events" USING btree ("attempt_id");
