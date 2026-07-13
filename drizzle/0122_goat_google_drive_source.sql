-- Google Drive as a personal Goat Brain source, with durable change cursors,
-- renewable push channels, and per-file debounce/lease state.
ALTER TABLE "goat"."integrations" DROP CONSTRAINT IF EXISTS "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack'));--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT IF EXISTS "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack'));--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" DROP CONSTRAINT IF EXISTS "goat_integration_resources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("goat"."integration_resources"."provider" IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack'));--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" DROP CONSTRAINT IF EXISTS "goat_brain_sources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" ADD CONSTRAINT "goat_brain_sources_provider_check" CHECK ("goat"."brain_sources"."provider" IN ('jamie', 'gmail', 'google_drive', 'github', 'slack', 'linear'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_provider_check" CHECK ("goat"."brain_source_items"."source_provider" IN ('jamie', 'goat-chat', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_type_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_type_check" CHECK ("goat"."brain_source_items"."source_type" IN ('meeting', 'capture', 'asset', 'conversation', 'issue', 'activity', 'thread', 'document'));--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_source_provider_check" CHECK ("goat"."brain_ingest_jobs"."source_provider" IN ('jamie', 'goat-chat', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive'));--> statement-breakpoint

CREATE TABLE "goat"."google_drive_sync_cursors" (
  "id" text PRIMARY KEY NOT NULL,
  "integration_id" text NOT NULL,
  "user_workos_id" text NOT NULL,
  "corpus_key" text NOT NULL,
  "drive_id" text,
  "page_token" text NOT NULL,
  "webhook_address" text NOT NULL,
  "wake_requested_at" timestamp with time zone,
  "lease_id" text,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "last_polled_at" timestamp with time zone,
  "last_successful_at" timestamp with time zone,
  "last_reset_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "goat"."google_drive_sync_cursors" ADD CONSTRAINT "goat_google_drive_sync_cursors_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."google_drive_sync_cursors" ADD CONSTRAINT "goat_google_drive_sync_cursors_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_google_drive_sync_cursors_integration_corpus_idx" ON "goat"."google_drive_sync_cursors" ("integration_id", "corpus_key");--> statement-breakpoint
CREATE INDEX "goat_google_drive_sync_cursors_due_idx" ON "goat"."google_drive_sync_cursors" ("wake_requested_at", "last_polled_at");--> statement-breakpoint
CREATE INDEX "goat_google_drive_sync_cursors_lease_idx" ON "goat"."google_drive_sync_cursors" ("lease_expires_at");--> statement-breakpoint

CREATE TABLE "goat"."google_drive_watch_channels" (
  "id" text PRIMARY KEY NOT NULL,
  "cursor_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "resource_id" text,
  "token_hash" text NOT NULL,
  "status" text DEFAULT 'creating' NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "goat_google_drive_watch_channels_status_check" CHECK ("goat"."google_drive_watch_channels"."status" IN ('creating', 'active', 'stopped'))
);--> statement-breakpoint
ALTER TABLE "goat"."google_drive_watch_channels" ADD CONSTRAINT "goat_google_drive_watch_channels_cursor_id_google_drive_sync_cursors_id_fk" FOREIGN KEY ("cursor_id") REFERENCES "goat"."google_drive_sync_cursors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."google_drive_watch_channels" ADD CONSTRAINT "goat_google_drive_watch_channels_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_google_drive_watch_channels_cursor_expiry_idx" ON "goat"."google_drive_watch_channels" ("cursor_id", "status", "expires_at");--> statement-breakpoint

CREATE TABLE "goat"."google_drive_file_states" (
  "id" text PRIMARY KEY NOT NULL,
  "integration_id" text NOT NULL,
  "user_workos_id" text NOT NULL,
  "file_id" text NOT NULL,
  "drive_id" text,
  "observed_version" text NOT NULL,
  "ingested_version" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "first_observed_at" timestamp with time zone NOT NULL,
  "last_observed_at" timestamp with time zone NOT NULL,
  "next_ingest_at" timestamp with time zone NOT NULL,
  "force_ingest_at" timestamp with time zone NOT NULL,
  "lease_id" text,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "last_source_item_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "goat"."google_drive_file_states" ADD CONSTRAINT "goat_google_drive_file_states_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."google_drive_file_states" ADD CONSTRAINT "goat_google_drive_file_states_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."google_drive_file_states" ADD CONSTRAINT "goat_google_drive_file_states_last_source_item_id_brain_source_items_id_fk" FOREIGN KEY ("last_source_item_id") REFERENCES "goat"."brain_source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_google_drive_file_states_integration_file_idx" ON "goat"."google_drive_file_states" ("integration_id", "file_id");--> statement-breakpoint
CREATE INDEX "goat_google_drive_file_states_due_idx" ON "goat"."google_drive_file_states" ("next_ingest_at", "force_ingest_at");--> statement-breakpoint
CREATE INDEX "goat_google_drive_file_states_lease_expiry_idx" ON "goat"."google_drive_file_states" ("lease_expires_at");
