-- Goat Slack bot (answer destination): a second, workspace-owned Slack app
-- that answers @mentions from brains. Widen provider checks for the new
-- 'slack_bot' provider on integrations, credentials, and brain_sources.
-- brain_sources rows with provider 'slack_bot' are answer destinations
-- (which channels a brain answers in), not ingestion sources; no ingestion
-- path reads them.
ALTER TABLE "goat"."integrations" DROP CONSTRAINT IF EXISTS "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT IF EXISTS "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'granola'));--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" DROP CONSTRAINT IF EXISTS "goat_brain_sources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" ADD CONSTRAINT "goat_brain_sources_provider_check" CHECK ("goat"."brain_sources"."provider" IN ('jamie', 'gmail', 'google_drive', 'github', 'slack', 'linear', 'slack_bot', 'granola'));
