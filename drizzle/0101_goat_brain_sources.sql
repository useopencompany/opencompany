-- Per-brain source configuration: which user-owned integration feeds which brain.
-- Also re-key ingest-job dedup so one source item can fan out to several brains
-- (one job per subscribed brain) while repeated webhook deliveries stay idempotent.
CREATE TABLE IF NOT EXISTS "goat"."brain_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"brain_id" text NOT NULL,
	"provider" text NOT NULL,
	"integration_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"created_by_workos_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_brain_sources_provider_check" CHECK ("goat"."brain_sources"."provider" IN ('jamie', 'gmail', 'github', 'slack'))
);--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" ADD CONSTRAINT "goat_brain_sources_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" ADD CONSTRAINT "goat_brain_sources_created_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("created_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_sources" ADD CONSTRAINT "goat_brain_sources_integration_user_provider_fk" FOREIGN KEY ("integration_id","user_workos_id","provider") REFERENCES "goat"."integrations"("id","user_workos_id","provider") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_brain_sources_brain_integration_idx" ON "goat"."brain_sources" ("brain_id","integration_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_brain_sources_integration_idx" ON "goat"."brain_sources" ("integration_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_brain_sources_brain_idx" ON "goat"."brain_sources" ("brain_id");--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_ingest_jobs_source_item_hash_kind_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_brain_ingest_jobs_item_hash_kind_brain_idx" ON "goat"."brain_ingest_jobs" ("source_item_id","content_hash","kind","brain_ref") WHERE "goat"."brain_ingest_jobs"."brain_ref" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_brain_ingest_jobs_item_hash_kind_nobrain_idx" ON "goat"."brain_ingest_jobs" ("source_item_id","content_hash","kind") WHERE "goat"."brain_ingest_jobs"."brain_ref" IS NULL;
