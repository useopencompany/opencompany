CREATE TABLE "agent_sync_jobs" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"path" text NOT NULL,
	"desired_hash" text NOT NULL,
	"desired_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "github_blob_sha" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "github_commit_sha" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "github_synced_hash" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "github_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "github_sync_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "github_sync_error" text;--> statement-breakpoint
ALTER TABLE "agent_sync_jobs" ADD CONSTRAINT "agent_sync_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sync_jobs" ADD CONSTRAINT "agent_sync_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sync_jobs_workspace_idx" ON "agent_sync_jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_sync_jobs_next_run_at_idx" ON "agent_sync_jobs" USING btree ("next_run_at");