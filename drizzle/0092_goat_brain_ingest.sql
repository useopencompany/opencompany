ALTER TABLE "goat"."integrations" DROP CONSTRAINT "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT "goat_integration_credentials_kind_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" DROP CONSTRAINT "goat_integration_resources_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'linear', 'github', 'jamie'));--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'linear', 'github', 'jamie'));--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_kind_check" CHECK ("goat"."integration_credentials"."kind" IN ('oauth_token', 'webhook_secret'));--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_provider_check" CHECK ("goat"."integration_resources"."provider" IN ('gmail', 'google_calendar', 'linear', 'github', 'jamie'));--> statement-breakpoint
CREATE TABLE "goat"."brain_source_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"provider" text NOT NULL,
	"source_type" text NOT NULL,
	"external_id" text NOT NULL,
	"source_ref" text NOT NULL,
	"title" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"normalized_payload" jsonb NOT NULL,
	"last_ingest_job_id" text,
	"last_ingest_status" text,
	"last_ingested_at" timestamp with time zone,
	"last_ingest_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_brain_source_items_provider_check" CHECK ("goat"."brain_source_items"."provider" IN ('gmail', 'google_calendar', 'linear', 'github', 'jamie')),
	CONSTRAINT "goat_brain_source_items_source_type_check" CHECK ("goat"."brain_source_items"."source_type" IN ('meeting')),
	CONSTRAINT "goat_brain_source_items_last_ingest_status_check" CHECK ("goat"."brain_source_items"."last_ingest_status" IS NULL OR "goat"."brain_source_items"."last_ingest_status" IN ('pending', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "goat"."brain_ingest_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_item_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_brain_ingest_jobs_provider_check" CHECK ("goat"."brain_ingest_jobs"."provider" IN ('gmail', 'google_calendar', 'linear', 'github', 'jamie')),
	CONSTRAINT "goat_brain_ingest_jobs_kind_check" CHECK ("goat"."brain_ingest_jobs"."kind" IN ('brain_source_item_ingest')),
	CONSTRAINT "goat_brain_ingest_jobs_status_check" CHECK ("goat"."brain_ingest_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "brain_source_items_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_integration_user_provider_fk" FOREIGN KEY ("integration_id","user_workos_id","provider") REFERENCES "goat"."integrations"("id","user_workos_id","provider") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "brain_ingest_jobs_source_item_id_brain_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "goat"."brain_source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "brain_ingest_jobs_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_source_items_integration_source_external_hash_idx" ON "goat"."brain_source_items" USING btree ("integration_id","source_type","external_id","content_hash");--> statement-breakpoint
CREATE INDEX "goat_brain_source_items_user_provider_occurred_idx" ON "goat"."brain_source_items" USING btree ("user_workos_id","provider","occurred_at");--> statement-breakpoint
CREATE INDEX "goat_brain_source_items_user_updated_idx" ON "goat"."brain_source_items" USING btree ("user_workos_id","updated_at");--> statement-breakpoint
CREATE INDEX "goat_brain_source_items_last_ingest_status_idx" ON "goat"."brain_source_items" USING btree ("last_ingest_status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_ingest_jobs_source_item_hash_kind_idx" ON "goat"."brain_ingest_jobs" USING btree ("source_item_id","content_hash","kind");--> statement-breakpoint
CREATE INDEX "goat_brain_ingest_jobs_status_next_run_idx" ON "goat"."brain_ingest_jobs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "goat_brain_ingest_jobs_lease_expires_at_idx" ON "goat"."brain_ingest_jobs" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "goat_brain_ingest_jobs_user_created_idx" ON "goat"."brain_ingest_jobs" USING btree ("user_workos_id","created_at");
