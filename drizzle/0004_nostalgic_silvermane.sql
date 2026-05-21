CREATE TABLE "workspace_repositories" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"github_repo_id" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"latest_head_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "config" SET DEFAULT '{"schemaVersion":"agent.v1","title":"Untitled agent","instructions":"","model":{"provider":"vercel-ai-gateway","name":"openai/gpt-5.4-mini"},"tools":[]}'::jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "body" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "workspace_repositories" ADD CONSTRAINT "workspace_repositories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_repositories_full_name_idx" ON "workspace_repositories" USING btree ("full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_workspace_path_idx" ON "agents" USING btree ("workspace_id","path");