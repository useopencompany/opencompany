CREATE TABLE "agent_file_sync_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"path" text NOT NULL,
	"operation" text DEFAULT 'upsert' NOT NULL,
	"desired_hash" text,
	"previous_path" text,
	"previous_blob_sha" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"github_blob_sha" text,
	"github_commit_sha" text,
	"github_synced_hash" text,
	"github_synced_at" timestamp with time zone,
	"github_sync_status" text DEFAULT 'pending' NOT NULL,
	"github_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_session_bundle_mounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"requested_path" text NOT NULL,
	"path" text NOT NULL,
	"reference_type" text DEFAULT 'file' NOT NULL,
	"base_hash" text,
	"last_synced_hash" text,
	"status" text DEFAULT 'mounted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_file_sync_jobs" ADD CONSTRAINT "agent_file_sync_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_bundle_mounts" ADD CONSTRAINT "agent_session_bundle_mounts_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_bundle_mounts" ADD CONSTRAINT "agent_session_bundle_mounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_file_sync_jobs_workspace_idx" ON "agent_file_sync_jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_file_sync_jobs_workspace_path_idx" ON "agent_file_sync_jobs" USING btree ("workspace_id","path");--> statement-breakpoint
CREATE INDEX "agent_file_sync_jobs_next_run_at_idx" ON "agent_file_sync_jobs" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "agent_files_workspace_idx" ON "agent_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_files_agent_idx" ON "agent_files" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_files_workspace_path_idx" ON "agent_files" USING btree ("workspace_id","path");--> statement-breakpoint
CREATE INDEX "agent_session_bundle_mounts_session_idx" ON "agent_session_bundle_mounts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_session_bundle_mounts_workspace_idx" ON "agent_session_bundle_mounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_bundle_mounts_session_path_idx" ON "agent_session_bundle_mounts" USING btree ("session_id","path");