-- Allow personal Dash0 OAuth connections. Existing provider values remain valid.
ALTER TABLE "goat"."integrations" DROP CONSTRAINT "goat_integrations_provider_check";
--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("provider" IN ('gmail', 'google_admin', 'google_calendar', 'google_drive', 'linear', 'github', 'github_user', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'betterstack', 'convex', 'render', 'vercel', 'signoz', 'dash0', 'stripe', 'latitude', 'posthog', 'neon', 'notion', 'supabase', 'resend', 'x_account', 'custom_mcp')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "goat"."integrations" VALIDATE CONSTRAINT "goat_integrations_provider_check";
--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT "goat_integration_credentials_provider_check";
--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("provider" IN ('gmail', 'google_admin', 'google_calendar', 'google_drive', 'linear', 'github', 'github_user', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'betterstack', 'convex', 'render', 'vercel', 'signoz', 'dash0', 'stripe', 'latitude', 'posthog', 'neon', 'notion', 'supabase', 'resend', 'x_account', 'custom_mcp')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" VALIDATE CONSTRAINT "goat_integration_credentials_provider_check";
--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" DROP CONSTRAINT "goat_integration_resources_provider_check";
--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("provider" IN ('gmail', 'google_admin', 'google_calendar', 'google_drive', 'linear', 'github', 'github_user', 'jamie', 'slack', 'hubspot', 'granola', 'fathom', 'attio', 'betterstack', 'convex', 'render', 'vercel', 'signoz', 'dash0', 'stripe', 'latitude', 'posthog', 'neon', 'notion', 'supabase', 'resend', 'x_account', 'custom_mcp')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" VALIDATE CONSTRAINT "goat_integration_resources_provider_check";
