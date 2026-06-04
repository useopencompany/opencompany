CREATE TABLE "workspace_sync_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repo_path" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text,
	"operation" text DEFAULT 'upsert' NOT NULL,
	"desired_hash" text,
	"previous_path" text,
	"previous_blob_sha" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_sync_jobs_source_kind_check" CHECK ("source_kind" IN ('brain', 'agent_file', 'agent')),
	CONSTRAINT "workspace_sync_jobs_operation_check" CHECK ("operation" IN ('upsert', 'delete')),
	CONSTRAINT "workspace_sync_jobs_status_check" CHECK ("status" IN ('pending', 'syncing', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "workspace_sync_jobs" ADD CONSTRAINT "workspace_sync_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_sync_jobs_workspace_idx" ON "workspace_sync_jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_sync_jobs_workspace_repo_path_idx" ON "workspace_sync_jobs" USING btree ("workspace_id","repo_path");--> statement-breakpoint
CREATE INDEX "workspace_sync_jobs_next_run_at_idx" ON "workspace_sync_jobs" USING btree ("next_run_at");
