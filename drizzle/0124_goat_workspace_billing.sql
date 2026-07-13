CREATE TABLE IF NOT EXISTS "goat"."workspace_billing" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"plan_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_subscription_item_id" text,
	"stripe_price_id" text,
	"subscription_status" text,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"current_period_end" timestamp with time zone,
	"desired_seat_quantity" integer DEFAULT 1 NOT NULL,
	"stripe_seat_quantity" integer,
	"seat_sync_pending_at" timestamp with time zone,
	"payment_needs_attention" boolean DEFAULT false NOT NULL,
	"last_stripe_event_created" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_workspace_billing_plan_check" CHECK ("plan" IN ('free', 'pro')),
	CONSTRAINT "goat_workspace_billing_desired_seat_quantity_check" CHECK ("desired_seat_quantity" > 0),
	CONSTRAINT "goat_workspace_billing_subscription_status_check" CHECK ("subscription_status" IS NULL OR "subscription_status" IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goat"."workspace_billing" ADD CONSTRAINT "goat_workspace_billing_workspace_id_goat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_workspace_billing_customer_idx" ON "goat"."workspace_billing" ("stripe_customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_workspace_billing_subscription_idx" ON "goat"."workspace_billing" ("stripe_subscription_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_workspace_billing_seat_sync_idx" ON "goat"."workspace_billing" ("seat_sync_pending_at");
--> statement-breakpoint
INSERT INTO "goat"."workspace_billing" ("workspace_id", "desired_seat_quantity")
SELECT workspace.id, GREATEST(1, count(member.id)::integer)
FROM "goat"."workspaces" AS workspace
LEFT JOIN "goat"."workspace_members" AS member ON member.workspace_id = workspace.id
GROUP BY workspace.id
ON CONFLICT ("workspace_id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."stripe_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"event_created_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD COLUMN IF NOT EXISTS "raw_event_count" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD COLUMN IF NOT EXISTS "workspace_id" text;
--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD COLUMN IF NOT EXISTS "plan_paused" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "goat"."brain_ingest_jobs" AS job
SET workspace_id = brain.workspace_id
FROM "goat"."brains" AS brain
WHERE job.brain_ref = brain.id AND job.workspace_id IS NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_workspace_id_goat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_brain_ingest_jobs_workspace_created_idx" ON "goat"."brain_ingest_jobs" ("workspace_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."workspace_ingestion_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_item_id" text NOT NULL,
	"source_provider" text NOT NULL,
	"raw_event_count" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_ingestion_reservations_status_check" CHECK ("status" IN ('pending', 'consumed')),
	CONSTRAINT "goat_ingestion_reservations_raw_event_count_check" CHECK ("raw_event_count" > 0 AND "raw_event_count" <= 200),
	CONSTRAINT "goat_ingestion_reservations_source_provider_check" CHECK ("source_provider" IN ('jamie', 'goat-chat', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive')),
	CONSTRAINT "goat_ingestion_reservations_consumption_state_check" CHECK (("status" = 'consumed' AND "consumed_at" IS NOT NULL) OR ("status" = 'pending' AND "consumed_at" IS NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goat"."workspace_ingestion_reservations" ADD CONSTRAINT "goat_ingestion_reservations_workspace_id_goat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goat"."workspace_ingestion_reservations" ADD CONSTRAINT "goat_ingestion_reservations_source_item_id_goat_brain_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "goat"."brain_source_items"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_ingestion_reservations_workspace_source_idx" ON "goat"."workspace_ingestion_reservations" ("workspace_id", "source_item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_ingestion_reservations_status_created_idx" ON "goat"."workspace_ingestion_reservations" ("workspace_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_ingestion_reservations_consumed_idx" ON "goat"."workspace_ingestion_reservations" ("workspace_id", "consumed_at");
--> statement-breakpoint
INSERT INTO "goat"."workspace_ingestion_reservations" (
	"id", "workspace_id", "source_item_id", "source_provider", "raw_event_count", "status", "consumed_at", "created_at", "updated_at"
)
SELECT
	'gir_' || md5(job.workspace_id || ':' || job.source_item_id),
	job.workspace_id,
	job.source_item_id,
	min(job.source_provider),
	1,
	'consumed',
	min(job.created_at),
	min(job.created_at),
	now()
FROM "goat"."brain_ingest_jobs" AS job
WHERE job.workspace_id IS NOT NULL
GROUP BY job.workspace_id, job.source_item_id
ON CONFLICT ("workspace_id", "source_item_id") DO NOTHING;
