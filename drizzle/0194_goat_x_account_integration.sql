-- X (Twitter) is a personal OAuth 2.0 + PKCE connection that posts tweets on
-- the connecting user's behalf. Distinct from the unrelated "x" managed
-- capability source (public, read-only X data via Apify/TikHub) — provider
-- "x_account" avoids colliding with that existing source id.
ALTER TABLE "goat"."integrations" DROP CONSTRAINT IF EXISTS "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'neon', 'imessage', 'x_account')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT IF EXISTS "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'neon', 'imessage', 'x_account')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" DROP CONSTRAINT IF EXISTS "goat_integration_resources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("goat"."integration_resources"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'neon', 'imessage', 'x_account')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."integrations" VALIDATE CONSTRAINT "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" VALIDATE CONSTRAINT "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" VALIDATE CONSTRAINT "goat_integration_resources_provider_check";
