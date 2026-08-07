-- Durable, versioned files explicitly published from Codex and Claude Code chat turns.
CREATE TABLE "goat"."chat_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"chat_session_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"current_version" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_chat_artifacts_current_version_check" CHECK ("goat"."chat_artifacts"."current_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "goat"."chat_artifact_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"blob_pathname" text NOT NULL,
	"source_engine" text NOT NULL,
	"source_tool_call_id" text NOT NULL,
	"source_turn_id" text,
	"source_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_chat_artifact_versions_version_size_check" CHECK ("goat"."chat_artifact_versions"."version" > 0 AND "goat"."chat_artifact_versions"."size_bytes" >= 0 AND "goat"."chat_artifact_versions"."size_bytes" <= 20971520),
	CONSTRAINT "goat_chat_artifact_versions_content_sha256_check" CHECK ("goat"."chat_artifact_versions"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "goat_chat_artifact_versions_source_engine_check" CHECK ("goat"."chat_artifact_versions"."source_engine" IN ('codex', 'claude_code'))
);
--> statement-breakpoint
ALTER TABLE "goat"."chat_artifacts" ADD CONSTRAINT "chat_artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."chat_artifacts" ADD CONSTRAINT "chat_artifacts_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."chat_artifacts" ADD CONSTRAINT "chat_artifacts_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."chat_artifact_versions" ADD CONSTRAINT "chat_artifact_versions_artifact_id_chat_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "goat"."chat_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."chat_artifact_versions" ADD CONSTRAINT "chat_artifact_versions_source_turn_id_codex_chat_turns_id_fk" FOREIGN KEY ("source_turn_id") REFERENCES "goat"."codex_chat_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."chat_artifact_versions" ADD CONSTRAINT "chat_artifact_versions_source_message_id_chat_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "goat"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_chat_artifacts_workspace_updated_idx" ON "goat"."chat_artifacts" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "goat_chat_artifacts_owner_chat_created_idx" ON "goat"."chat_artifacts" USING btree ("user_workos_id","chat_session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_chat_artifact_versions_artifact_version_idx" ON "goat"."chat_artifact_versions" USING btree ("artifact_id","version");--> statement-breakpoint
CREATE INDEX "goat_chat_artifact_versions_source_turn_created_idx" ON "goat"."chat_artifact_versions" USING btree ("source_turn_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_chat_artifact_versions_source_turn_tool_call_idx" ON "goat"."chat_artifact_versions" USING btree ("source_turn_id","source_tool_call_id");--> statement-breakpoint
CREATE INDEX "goat_chat_artifact_versions_source_message_idx" ON "goat"."chat_artifact_versions" USING btree ("source_message_id");
