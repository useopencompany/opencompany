-- The browser-listing experiment reached production before it was reverted.
-- Remove its persisted state and restore the provider constraints so the
-- source revert also leaves deployed databases in the pre-experiment shape.
-- Add the restored checks as NOT VALID first: they reject new experiment rows
-- immediately while allowing us to clean up any rows already stored.
ALTER TABLE "goat"."integrations"
  DROP CONSTRAINT IF EXISTS "goat_integrations_provider_check",
  ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials"
  DROP CONSTRAINT IF EXISTS "goat_integration_credentials_provider_check",
  ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."integration_resources"
  DROP CONSTRAINT IF EXISTS "goat_integration_resources_provider_check",
  ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("goat"."integration_resources"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude')) NOT VALID;--> statement-breakpoint

DROP TABLE IF EXISTS "goat"."browser_action_runs";--> statement-breakpoint
DELETE FROM "goat"."integration_resources" WHERE "provider" = 'kleinanzeigen';--> statement-breakpoint
DELETE FROM "goat"."integration_credentials" WHERE "provider" = 'kleinanzeigen';--> statement-breakpoint
DELETE FROM "goat"."integrations" WHERE "provider" = 'kleinanzeigen';--> statement-breakpoint

ALTER TABLE "goat"."integrations" VALIDATE CONSTRAINT "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" VALIDATE CONSTRAINT "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" VALIDATE CONSTRAINT "goat_integration_resources_provider_check";
