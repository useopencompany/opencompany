CREATE TABLE "workspace_skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
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
ALTER TABLE "workspace_sync_jobs" DROP CONSTRAINT "workspace_sync_jobs_source_kind_check";--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_skills_workspace_idx" ON "workspace_skills" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_skills_workspace_skill_id_idx" ON "workspace_skills" USING btree ("workspace_id","skill_id");--> statement-breakpoint
ALTER TABLE "workspace_sync_jobs" ADD CONSTRAINT "workspace_sync_jobs_source_kind_check" CHECK ("workspace_sync_jobs"."source_kind" IN ('brain', 'agent_file', 'agent', 'skill'));