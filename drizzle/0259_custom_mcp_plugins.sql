-- Personal custom MCP credentials use the existing encrypted integration vault.
ALTER TABLE "goat"."integrations" DROP CONSTRAINT "goat_integrations_provider_check";
--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'github_user', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'betterstack', 'render', 'vercel', 'signoz', 'stripe', 'latitude', 'posthog', 'neon', 'notion', 'supabase', 'x_account', 'custom_mcp'));
--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT "goat_integration_credentials_provider_check";
--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'github_user', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'betterstack', 'render', 'vercel', 'signoz', 'stripe', 'latitude', 'posthog', 'neon', 'notion', 'supabase', 'x_account', 'custom_mcp'));
--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" DROP CONSTRAINT "goat_integration_resources_provider_check";
--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'github_user', 'jamie', 'slack', 'hubspot', 'granola', 'fathom', 'attio', 'betterstack', 'render', 'vercel', 'signoz', 'stripe', 'latitude', 'posthog', 'neon', 'notion', 'supabase', 'x_account', 'custom_mcp'));
--> statement-breakpoint
ALTER TABLE "goat"."plugins" DROP CONSTRAINT "plugins_source_type_check";
--> statement-breakpoint
ALTER TABLE "goat"."plugins" DROP CONSTRAINT "plugins_commit_check";
--> statement-breakpoint
ALTER TABLE "goat"."plugins" ADD CONSTRAINT "plugins_source_type_check" CHECK ("source_type" IN ('github', 'skills.sh', 'custom_mcp'));
--> statement-breakpoint
ALTER TABLE "goat"."plugins" ADD CONSTRAINT "plugins_commit_check" CHECK (("source_type" <> 'custom_mcp' AND "resolved_commit" ~ '^[0-9a-f]{40}$') OR ("source_type" = 'custom_mcp' AND "resolved_commit" = '' AND "source_ref" = '' AND "source_path" = ''));
--> statement-breakpoint
CREATE TABLE "goat"."custom_mcp_accounts" (
  "integration_id" text PRIMARY KEY REFERENCES "goat"."integrations" ("id") ON DELETE CASCADE,
  "workspace_id" text NOT NULL REFERENCES "goat"."workspaces" ("id") ON DELETE CASCADE,
  "plugin_name" text NOT NULL,
  "user_workos_id" text NOT NULL REFERENCES "goat"."users" ("workos_user_id") ON DELETE CASCADE,
  "revision" text NOT NULL,
  "tools" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "checked_at" timestamp with time zone NOT NULL DEFAULT now(),
  "error" text,
  CONSTRAINT "custom_mcp_accounts_tools_check" CHECK (jsonb_typeof("tools") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "custom_mcp_accounts_owner_plugin_idx" ON "goat"."custom_mcp_accounts" ("workspace_id", "plugin_name", "user_workos_id");
