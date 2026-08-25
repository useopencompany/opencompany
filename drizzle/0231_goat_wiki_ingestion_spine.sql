CREATE TABLE IF NOT EXISTS "goat"."wiki_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "goat"."workspaces"("id") ON DELETE CASCADE,
	"provider" text NOT NULL,
	"integration_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"created_by_workos_id" text NOT NULL REFERENCES "goat"."users"("workos_user_id") ON DELETE CASCADE,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opencompany_wiki_sources_integration_user_provider_fk" FOREIGN KEY ("integration_id", "user_workos_id", "provider") REFERENCES "goat"."integrations"("id", "user_workos_id", "provider") ON DELETE CASCADE,
	CONSTRAINT "opencompany_wiki_sources_provider_check" CHECK ("provider" IN ('gmail', 'slack', 'jamie', 'granola', 'linear', 'github'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "opencompany_wiki_sources_workspace_integration_idx" ON "goat"."wiki_sources" ("workspace_id", "integration_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opencompany_wiki_sources_integration_idx" ON "goat"."wiki_sources" ("integration_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opencompany_wiki_sources_workspace_idx" ON "goat"."wiki_sources" ("workspace_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "goat"."wiki_source_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "goat"."workspaces"("id") ON DELETE CASCADE,
	"source_provider" text NOT NULL,
	"source_connection_id" text NOT NULL,
	"integration_id" text NOT NULL REFERENCES "goat"."integrations"("id") ON DELETE CASCADE,
	"source_type" text NOT NULL,
	"external_id" text NOT NULL,
	"source_ref" text NOT NULL,
	"title" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"normalized_payload" jsonb NOT NULL,
	"raw_event_count" integer DEFAULT 1 NOT NULL,
	"last_ingest_job_id" text,
	"last_ingest_status" text,
	"last_ingested_at" timestamp with time zone,
	"last_ingest_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opencompany_wiki_source_items_source_provider_check" CHECK ("source_provider" IN ('gmail', 'slack', 'jamie', 'granola', 'linear', 'github')),
	CONSTRAINT "opencompany_wiki_source_items_source_type_check" CHECK ("source_type" IN ('meeting', 'conversation', 'issue', 'activity', 'thread')),
	CONSTRAINT "opencompany_wiki_source_items_last_ingest_status_check" CHECK ("last_ingest_status" IS NULL OR "last_ingest_status" IN ('pending', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "opencompany_wiki_source_items_raw_event_count_check" CHECK ("raw_event_count" > 0 AND "raw_event_count" <= 200)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "opencompany_wiki_source_items_connection_external_hash_idx" ON "goat"."wiki_source_items" ("workspace_id", "source_provider", "source_connection_id", "source_type", "external_id", "content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opencompany_wiki_source_items_workspace_provider_occurred_idx" ON "goat"."wiki_source_items" ("workspace_id", "source_provider", "occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opencompany_wiki_source_items_workspace_updated_idx" ON "goat"."wiki_source_items" ("workspace_id", "updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opencompany_wiki_source_items_last_ingest_status_idx" ON "goat"."wiki_source_items" ("last_ingest_status", "updated_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "goat"."wiki_ingest_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "goat"."workspaces"("id") ON DELETE CASCADE,
	"source_item_id" text NOT NULL REFERENCES "goat"."wiki_source_items"("id") ON DELETE CASCADE,
	"source_provider" text NOT NULL,
	"source_connection_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"last_error" text,
	"skip_reason" text,
	"trace_ref" text,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opencompany_wiki_ingest_jobs_source_provider_check" CHECK ("source_provider" IN ('gmail', 'slack', 'jamie', 'granola', 'linear', 'github')),
	CONSTRAINT "opencompany_wiki_ingest_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'skipped'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "opencompany_wiki_ingest_jobs_item_hash_idx" ON "goat"."wiki_ingest_jobs" ("source_item_id", "content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "opencompany_wiki_ingest_jobs_workspace_running_idx" ON "goat"."wiki_ingest_jobs" ("workspace_id") WHERE "status" = 'running';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opencompany_wiki_ingest_jobs_status_next_retry_idx" ON "goat"."wiki_ingest_jobs" ("status", "next_retry_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opencompany_wiki_ingest_jobs_lease_expires_at_idx" ON "goat"."wiki_ingest_jobs" ("lease_expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opencompany_wiki_ingest_jobs_workspace_created_idx" ON "goat"."wiki_ingest_jobs" ("workspace_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opencompany_wiki_ingest_jobs_workspace_integration_status_idx" ON "goat"."wiki_ingest_jobs" ("workspace_id", "integration_id", "status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "goat"."wiki_source_event_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "goat"."workspaces"("id") ON DELETE CASCADE,
	"source_provider" text NOT NULL,
	"event_key" text NOT NULL,
	"source_item_id" text REFERENCES "goat"."wiki_source_items"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opencompany_wiki_source_event_claims_source_provider_check" CHECK ("source_provider" IN ('gmail', 'slack', 'jamie', 'granola', 'linear', 'github'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "opencompany_wiki_source_event_claims_workspace_provider_key_idx" ON "goat"."wiki_source_event_claims" ("workspace_id", "source_provider", "event_key");--> statement-breakpoint

-- Billing admission is shared by the brain and wiki pipelines. Separate
-- nullable FKs preserve source-item cascade cleanup while the check below
-- keeps every reservation owned by exactly one ingestion pipeline.
ALTER TABLE "goat"."workspace_ingestion_reservations"
ALTER COLUMN "source_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."workspace_ingestion_reservations"
ADD COLUMN IF NOT EXISTS "wiki_source_item_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goat"."workspace_ingestion_reservations" ADD CONSTRAINT "opencompany_ingestion_reservations_wiki_source_item_fk" FOREIGN KEY ("wiki_source_item_id") REFERENCES "goat"."wiki_source_items"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "opencompany_ingestion_reservations_workspace_wiki_source_idx" ON "goat"."workspace_ingestion_reservations" ("workspace_id", "wiki_source_item_id") WHERE "wiki_source_item_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."workspace_ingestion_reservations"
DROP CONSTRAINT IF EXISTS "opencompany_ingestion_reservations_source_kind_check";--> statement-breakpoint
ALTER TABLE "goat"."workspace_ingestion_reservations"
ADD CONSTRAINT "opencompany_ingestion_reservations_source_kind_check"
CHECK (("source_item_id" IS NOT NULL AND "wiki_source_item_id" IS NULL) OR ("source_item_id" IS NULL AND "wiki_source_item_id" IS NOT NULL));
