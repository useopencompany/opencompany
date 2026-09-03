ALTER TABLE "goat"."brain_import_runs" ALTER COLUMN "brain_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."brain_import_runs" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_import_candidates" ADD COLUMN "wiki_ingest_job_id" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_import_runs" ADD CONSTRAINT "brain_import_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade;--> statement-breakpoint
DROP INDEX "goat"."goat_brain_import_runs_active_brain_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_import_runs_active_brain_idx" ON "goat"."brain_import_runs" USING btree ("brain_ref") WHERE "brain_ref" IS NOT NULL AND "status" IN ('discovering', 'awaiting_confirmation', 'ingesting', 'finalizing');--> statement-breakpoint
CREATE UNIQUE INDEX "opencompany_brain_import_runs_active_workspace_idx" ON "goat"."brain_import_runs" USING btree ("workspace_id") WHERE "workspace_id" IS NOT NULL AND "status" IN ('discovering', 'awaiting_confirmation', 'ingesting', 'finalizing');--> statement-breakpoint
CREATE INDEX "opencompany_brain_import_runs_workspace_created_idx" ON "goat"."brain_import_runs" USING btree ("workspace_id", "created_at");--> statement-breakpoint
CREATE INDEX "opencompany_brain_import_candidates_wiki_ingest_job_idx" ON "goat"."brain_import_candidates" USING btree ("wiki_ingest_job_id");--> statement-breakpoint
ALTER TABLE "goat"."brain_import_runs" ADD CONSTRAINT "opencompany_brain_import_runs_target_check" CHECK (("brain_ref" IS NOT NULL AND "workspace_id" IS NULL) OR ("brain_ref" IS NULL AND "workspace_id" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "goat"."wiki_source_items" ALTER COLUMN "integration_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."wiki_source_items" DROP CONSTRAINT "opencompany_wiki_source_items_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."wiki_source_items" DROP CONSTRAINT "opencompany_wiki_source_items_source_type_check";--> statement-breakpoint
ALTER TABLE "goat"."wiki_source_items" ADD CONSTRAINT "opencompany_wiki_source_items_source_provider_check" CHECK ("source_provider" IN ('gmail', 'slack', 'jamie', 'granola', 'linear', 'github', 'opencompany-import'));--> statement-breakpoint
ALTER TABLE "goat"."wiki_source_items" ADD CONSTRAINT "opencompany_wiki_source_items_source_type_check" CHECK ("source_type" IN ('meeting', 'conversation', 'issue', 'activity', 'thread', 'run'));--> statement-breakpoint
ALTER TABLE "goat"."wiki_source_items" ADD CONSTRAINT "opencompany_wiki_source_items_integration_check" CHECK (("source_provider" = 'opencompany-import' AND "integration_id" IS NULL AND "source_type" = 'run') OR ("source_provider" <> 'opencompany-import' AND "integration_id" IS NOT NULL AND "source_type" <> 'run'));--> statement-breakpoint

ALTER TABLE "goat"."wiki_ingest_jobs" ALTER COLUMN "integration_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."wiki_ingest_jobs" ADD COLUMN "import_run_id" text;--> statement-breakpoint
ALTER TABLE "goat"."wiki_ingest_jobs" ADD CONSTRAINT "wiki_ingest_jobs_import_run_id_brain_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "goat"."brain_import_runs"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "goat"."wiki_ingest_jobs" DROP CONSTRAINT "opencompany_wiki_ingest_jobs_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."wiki_ingest_jobs" ADD CONSTRAINT "opencompany_wiki_ingest_jobs_source_provider_check" CHECK ("source_provider" IN ('gmail', 'slack', 'jamie', 'granola', 'linear', 'github', 'opencompany-import'));--> statement-breakpoint
ALTER TABLE "goat"."wiki_ingest_jobs" ADD CONSTRAINT "opencompany_wiki_ingest_jobs_import_target_check" CHECK (("source_provider" = 'opencompany-import' AND "integration_id" IS NULL AND "import_run_id" IS NOT NULL) OR ("source_provider" <> 'opencompany-import' AND "integration_id" IS NOT NULL));--> statement-breakpoint
CREATE INDEX "opencompany_wiki_ingest_jobs_import_run_idx" ON "goat"."wiki_ingest_jobs" USING btree ("import_run_id");--> statement-breakpoint
ALTER TABLE "goat"."brain_import_candidates" ADD CONSTRAINT "brain_import_candidates_wiki_ingest_job_id_wiki_ingest_jobs_id_fk" FOREIGN KEY ("wiki_ingest_job_id") REFERENCES "goat"."wiki_ingest_jobs"("id") ON DELETE set null;--> statement-breakpoint

ALTER TABLE "goat"."workspace_ingestion_reservations" DROP CONSTRAINT "goat_ingestion_reservations_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."workspace_ingestion_reservations" ADD CONSTRAINT "goat_ingestion_reservations_source_provider_check" CHECK ("source_provider" IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'hubspot', 'granola', 'fathom', 'attio', 'opencompany-import'));
