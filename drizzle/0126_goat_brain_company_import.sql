CREATE TABLE "goat"."brain_import_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"brain_ref" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"company_url" text NOT NULL,
	"company_domain" text NOT NULL,
	"company_name" text,
	"focus" text,
	"history_start_at" timestamp with time zone NOT NULL,
	"history_end_at" timestamp with time zone NOT NULL,
	"source_selection" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discovery_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'discovering' NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_brain_import_runs_status_check" CHECK ("goat"."brain_import_runs"."status" IN ('discovering', 'awaiting_confirmation', 'ingesting', 'finalizing', 'succeeded', 'partial', 'failed', 'canceled')),
	CONSTRAINT "goat_brain_import_runs_history_window_check" CHECK ("goat"."brain_import_runs"."history_start_at" < "goat"."brain_import_runs"."history_end_at")
);
--> statement-breakpoint
ALTER TABLE "goat"."brain_import_runs" ADD CONSTRAINT "goat_brain_import_runs_brain_ref_goat_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "goat"."brain_import_runs" ADD CONSTRAINT "goat_brain_import_runs_user_workos_id_goat_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_import_runs_active_brain_idx" ON "goat"."brain_import_runs" USING btree ("brain_ref") WHERE "goat"."brain_import_runs"."status" IN ('discovering', 'awaiting_confirmation', 'ingesting', 'finalizing');--> statement-breakpoint
CREATE INDEX "goat_brain_import_runs_status_next_run_idx" ON "goat"."brain_import_runs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "goat_brain_import_runs_lease_expires_at_idx" ON "goat"."brain_import_runs" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "goat_brain_import_runs_brain_created_idx" ON "goat"."brain_import_runs" USING btree ("brain_ref","created_at");--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD COLUMN "import_run_id" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_document_versions" ADD COLUMN "import_run_id" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_import_run_id_goat_brain_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "goat"."brain_import_runs"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "goat"."brain_document_versions" ADD CONSTRAINT "goat_brain_document_versions_import_run_id_goat_brain_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "goat"."brain_import_runs"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "goat_brain_ingest_jobs_import_run_idx" ON "goat"."brain_ingest_jobs" USING btree ("import_run_id");--> statement-breakpoint
CREATE INDEX "goat_brain_document_versions_import_run_created_idx" ON "goat"."brain_document_versions" USING btree ("import_run_id","created_at");--> statement-breakpoint
CREATE TABLE "goat"."brain_import_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"import_run_id" text NOT NULL,
	"provider" text NOT NULL,
	"source_item_id" text NOT NULL,
	"ingest_job_id" text,
	"entry_count" integer DEFAULT 1 NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"selected" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_brain_import_candidates_provider_check" CHECK ("goat"."brain_import_candidates"."provider" IN ('public_web', 'github', 'jamie', 'gmail', 'slack', 'linear'))
);
--> statement-breakpoint
ALTER TABLE "goat"."brain_import_candidates" ADD CONSTRAINT "goat_brain_import_candidates_import_run_id_goat_brain_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "goat"."brain_import_runs"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "goat"."brain_import_candidates" ADD CONSTRAINT "goat_brain_import_candidates_source_item_id_goat_brain_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "goat"."brain_source_items"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "goat"."brain_import_candidates" ADD CONSTRAINT "goat_brain_import_candidates_ingest_job_id_goat_brain_ingest_jobs_id_fk" FOREIGN KEY ("ingest_job_id") REFERENCES "goat"."brain_ingest_jobs"("id") ON DELETE set null;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_import_candidates_run_source_idx" ON "goat"."brain_import_candidates" USING btree ("import_run_id","source_item_id");--> statement-breakpoint
CREATE INDEX "goat_brain_import_candidates_run_provider_rank_idx" ON "goat"."brain_import_candidates" USING btree ("import_run_id","provider","rank");--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_provider_check" CHECK ("goat"."brain_source_items"."source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_type_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_type_check" CHECK ("goat"."brain_source_items"."source_type" IN ('meeting', 'run', 'capture', 'asset', 'conversation', 'issue', 'activity', 'thread', 'document'));--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_source_provider_check" CHECK ("goat"."brain_ingest_jobs"."source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive'));--> statement-breakpoint
ALTER TABLE "goat"."workspace_ingestion_reservations" DROP CONSTRAINT IF EXISTS "goat_ingestion_reservations_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."workspace_ingestion_reservations" ADD CONSTRAINT "goat_ingestion_reservations_source_provider_check" CHECK ("goat"."workspace_ingestion_reservations"."source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive'));
