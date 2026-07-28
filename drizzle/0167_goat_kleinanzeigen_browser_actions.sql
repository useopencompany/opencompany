-- Kleinanzeigen is a personal, user-operated browser integration. The
-- Browser Use API key, profile id, and file-workspace id are encrypted in the
-- generic integration credential row.
ALTER TABLE "goat"."integrations" DROP CONSTRAINT IF EXISTS "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'kleinanzeigen'));--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT IF EXISTS "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'kleinanzeigen'));--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" DROP CONSTRAINT IF EXISTS "goat_integration_resources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("goat"."integration_resources"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'kleinanzeigen'));--> statement-breakpoint

CREATE TABLE "goat"."browser_action_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "user_workos_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "chat_session_id" text,
  "tool_call_id" text NOT NULL,
  "action" text NOT NULL,
  "input_hash" text NOT NULL,
  "provider_session_id" text,
  "status" text DEFAULT 'starting' NOT NULL,
  "result" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "goat_browser_action_runs_status_check" CHECK ("goat"."browser_action_runs"."status" IN ('starting', 'running', 'needs_attention', 'succeeded', 'failed'))
);--> statement-breakpoint
ALTER TABLE "goat"."browser_action_runs" ADD CONSTRAINT "goat_browser_action_runs_user_workos_id_goat_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "goat"."browser_action_runs" ADD CONSTRAINT "goat_browser_action_runs_integration_id_goat_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_browser_action_runs_user_chat_tool_idx" ON "goat"."browser_action_runs" USING btree ("user_workos_id","chat_session_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "goat_browser_action_runs_integration_session_idx" ON "goat"."browser_action_runs" USING btree ("integration_id","provider_session_id");--> statement-breakpoint
CREATE INDEX "goat_browser_action_runs_status_updated_idx" ON "goat"."browser_action_runs" USING btree ("status","updated_at");
