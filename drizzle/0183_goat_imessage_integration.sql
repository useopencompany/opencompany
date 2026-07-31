-- iMessage is a personal one-way notification channel. The paired phone lives
-- on a goat.integrations row (account_name, E.164); no credential row is
-- stored because the provider API key is platform-level env. Pairing
-- challenges and the send log live in dedicated unsynced tables so the OTP
-- hash never reaches Electric clients.
ALTER TABLE "goat"."users" ADD COLUMN IF NOT EXISTS "imessage_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "goat"."integrations" DROP CONSTRAINT IF EXISTS "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'imessage'));--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT IF EXISTS "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'imessage'));--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" DROP CONSTRAINT IF EXISTS "goat_integration_resources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("goat"."integration_resources"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'imessage'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."imessage_pairing_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"phone_e164" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempt_count" integer NOT NULL DEFAULT 0,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "goat_imessage_pairing_challenges_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_imessage_pairing_challenges_user_idx" ON "goat"."imessage_pairing_challenges" ("user_workos_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."imessage_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"source" text NOT NULL,
	"chat_session_id" text,
	"status" text NOT NULL,
	"error_reason" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "goat_imessage_sends_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade,
	CONSTRAINT "goat_imessage_sends_source_check" CHECK ("source" IN ('chat', 'task', 'pairing')),
	CONSTRAINT "goat_imessage_sends_status_check" CHECK ("status" IN ('sent', 'failed'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_imessage_sends_user_created_idx" ON "goat"."imessage_sends" ("user_workos_id", "created_at");
