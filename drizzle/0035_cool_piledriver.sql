CREATE TABLE "workspace_sync_jobs" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "agent_file_sync_jobs" CASCADE;--> statement-breakpoint
DROP TABLE "agent_sync_jobs" CASCADE;--> statement-breakpoint
DROP TABLE "brain_sync_jobs" CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_sync_jobs" ADD CONSTRAINT "workspace_sync_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_sync_jobs_next_run_at_idx" ON "workspace_sync_jobs" USING btree ("next_run_at");--> statement-breakpoint
ALTER TABLE "agent_files" DROP COLUMN "github_blob_sha";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "github_blob_sha";--> statement-breakpoint
ALTER TABLE "brain_files" DROP COLUMN "github_blob_sha";--> statement-breakpoint
-- Backfill: mark every workspace that already has a managed GitHub repo as dirty
-- so the first per-workspace reconcile re-materializes/heals its full tree.
-- Idempotent: a reconcile with no diff is a no-op (no commit).
INSERT INTO "workspace_sync_jobs" ("workspace_id", "status", "next_run_at")
SELECT "workspace_id", 'pending', now()
FROM "workspace_repositories"
ON CONFLICT ("workspace_id") DO NOTHING;