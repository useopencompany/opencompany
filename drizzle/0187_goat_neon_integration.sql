-- Neon is a personal remote-MCP integration. OAuth credentials are encrypted
-- in integration_credentials; the hosted endpoint and OAuth grant are both
-- forced into read-only mode, and Neon does not feed Brain ingestion directly.
ALTER TABLE "goat"."integrations" DROP CONSTRAINT IF EXISTS "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'neon', 'imessage')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT IF EXISTS "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'neon', 'imessage')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" DROP CONSTRAINT IF EXISTS "goat_integration_resources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("goat"."integration_resources"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'neon', 'imessage')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."integrations" VALIDATE CONSTRAINT "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" VALIDATE CONSTRAINT "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" VALIDATE CONSTRAINT "goat_integration_resources_provider_check";
