CREATE TABLE "agent_session_amp_artifacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text,
	"tool_call_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"branch_name" text,
	"pull_request_url" text,
	"diff_stat" text,
	"diff_preview" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_github_integration_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text,
	"account_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_github_integration_repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"github_repo_id" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"private" boolean DEFAULT true NOT NULL,
	"selected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "config" SET DEFAULT '{"version":2,"title":"Untitled agent","instructions":"","model":{"provider":"vercel-ai-gateway","name":"openai/gpt-5.4-mini"},"tools":[],"integrations":{"github":{"repositories":[]}},"triggers":[]}'::jsonb;--> statement-breakpoint
UPDATE "agents"
SET "config" = jsonb_build_object(
	'version', 2,
	'title', "name",
	'instructions', "body",
	'model', COALESCE("config"->'model', '{"provider":"vercel-ai-gateway","name":"openai/gpt-5.4-mini"}'::jsonb),
	'tools', '[]'::jsonb,
	'integrations', '{"github":{"repositories":[]}}'::jsonb,
	'triggers', '[]'::jsonb
)
WHERE "config"->>'version' IS DISTINCT FROM '2';--> statement-breakpoint
ALTER TABLE "agent_session_amp_artifacts" ADD CONSTRAINT "agent_session_amp_artifacts_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_amp_artifacts" ADD CONSTRAINT "agent_session_amp_artifacts_message_id_agent_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."agent_session_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_github_integration_installations" ADD CONSTRAINT "workspace_github_integration_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_github_integration_repositories" ADD CONSTRAINT "workspace_github_integration_repositories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_session_amp_artifacts_session_idx" ON "agent_session_amp_artifacts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_session_amp_artifacts_tool_call_idx" ON "agent_session_amp_artifacts" USING btree ("tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_github_integration_installations_workspace_idx" ON "workspace_github_integration_installations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_github_integration_installations_installation_idx" ON "workspace_github_integration_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "workspace_github_integration_repositories_workspace_idx" ON "workspace_github_integration_repositories" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_github_integration_repositories_workspace_full_name_idx" ON "workspace_github_integration_repositories" USING btree ("workspace_id","full_name");
