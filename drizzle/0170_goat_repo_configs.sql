-- Workspace-shared, per-repository bootstrap configuration for the repo-agnostic
-- Goat Codex and Claude Code chat sandboxes. Environment contents are encrypted;
-- only key names remain plaintext for the settings UI.
CREATE TABLE IF NOT EXISTS "goat"."repo_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_external_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"encrypted_env_payload" jsonb,
	"encryption_key_version" integer,
	"env_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"setup_instructions" text DEFAULT '' NOT NULL,
	"created_by_workos_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_repo_configs_env_encryption_check" CHECK (("encrypted_env_payload" IS NULL AND "encryption_key_version" IS NULL) OR ("encrypted_env_payload" IS NOT NULL AND "encryption_key_version" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "goat"."repo_configs" ADD CONSTRAINT "goat_repo_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."repo_configs" ADD CONSTRAINT "goat_repo_configs_created_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("created_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_repo_configs_workspace_repository_idx" ON "goat"."repo_configs" ("workspace_id","repository_external_id");
