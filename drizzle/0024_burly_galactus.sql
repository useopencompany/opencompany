ALTER TABLE "workspace_integration_resources" ADD COLUMN "status" text DEFAULT 'available' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_integration_resources" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "workspace_integration_resources" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_integrations" ADD COLUMN "connection_label" text;--> statement-breakpoint
ALTER TABLE "workspace_integrations" ADD COLUMN "account_email" text;--> statement-breakpoint
ALTER TABLE "workspace_integrations" ADD COLUMN "connected_by_user_id" text;--> statement-breakpoint
ALTER TABLE "workspace_integrations" ADD COLUMN "status" text DEFAULT 'connected' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_integrations" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "workspace_integrations" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_integrations" ADD COLUMN "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "workspace_integrations"
SET
	"connection_label" = COALESCE(NULLIF("account_name", ''), CASE WHEN "provider" = 'github' THEN 'GitHub' ELSE "provider" END),
	"status" = 'connected',
	"last_synced_at" = "updated_at"
WHERE "connection_label" IS NULL OR "last_synced_at" IS NULL;--> statement-breakpoint
UPDATE "workspace_integration_resources"
SET
	"status" = 'available',
	"last_synced_at" = "updated_at"
WHERE "last_synced_at" IS NULL;--> statement-breakpoint
CREATE TABLE "workspace_integration_resources_0024_backup" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"provider" text NOT NULL,
	"resource_type" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'available' NOT NULL,
	"status_reason" text,
	"last_synced_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"selected_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"backup_reason" text NOT NULL,
	"backed_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_integration_resources_0024_backup_id_reason_unique" UNIQUE("id","backup_reason")
);
--> statement-breakpoint
INSERT INTO "workspace_integration_resources_0024_backup" (
	"id",
	"workspace_id",
	"integration_id",
	"provider",
	"resource_type",
	"external_id",
	"name",
	"display_name",
	"status",
	"status_reason",
	"last_synced_at",
	"metadata",
	"selected_at",
	"created_at",
	"updated_at",
	"backup_reason"
)
SELECT
	resource."id",
	resource."workspace_id",
	resource."integration_id",
	resource."provider",
	resource."resource_type",
	resource."external_id",
	resource."name",
	resource."display_name",
	resource."status",
	resource."status_reason",
	resource."last_synced_at",
	resource."metadata",
	resource."selected_at",
	resource."created_at",
	resource."updated_at",
	'orphan_integration'
FROM "workspace_integration_resources" resource
WHERE NOT EXISTS (
	SELECT 1
	FROM "workspace_integrations" integration
	WHERE integration."id" = resource."integration_id"
)
ON CONFLICT ("id","backup_reason") DO NOTHING;--> statement-breakpoint
DELETE FROM "workspace_integration_resources" resource
WHERE NOT EXISTS (
	SELECT 1
	FROM "workspace_integrations" integration
	WHERE integration."id" = resource."integration_id"
);--> statement-breakpoint
DROP INDEX "workspace_integration_resources_workspace_provider_type_name_idx";--> statement-breakpoint
DROP INDEX "workspace_integration_resources_workspace_provider_type_external_idx";--> statement-breakpoint
UPDATE "workspace_integration_resources" resource
SET
	"workspace_id" = integration."workspace_id",
	"provider" = integration."provider"
FROM "workspace_integrations" integration
WHERE resource."integration_id" = integration."id"
	AND (
		resource."workspace_id" IS DISTINCT FROM integration."workspace_id"
		OR resource."provider" IS DISTINCT FROM integration."provider"
	);--> statement-breakpoint
ALTER TABLE "workspace_integrations" ADD CONSTRAINT "workspace_integrations_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_integrations_id_workspace_provider_idx" ON "workspace_integrations" USING btree ("id","workspace_id","provider");--> statement-breakpoint
ALTER TABLE "workspace_integration_resources" DROP CONSTRAINT "workspace_integration_resources_integration_id_workspace_integrations_id_fk";--> statement-breakpoint
ALTER TABLE "workspace_integration_resources" ADD CONSTRAINT "workspace_integration_resources_integration_workspace_provider_fk" FOREIGN KEY ("integration_id","workspace_id","provider") REFERENCES "public"."workspace_integrations"("id","workspace_id","provider") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "workspace_integration_resources_0024_backup" (
	"id",
	"workspace_id",
	"integration_id",
	"provider",
	"resource_type",
	"external_id",
	"name",
	"display_name",
	"status",
	"status_reason",
	"last_synced_at",
	"metadata",
	"selected_at",
	"created_at",
	"updated_at",
	"backup_reason"
)
SELECT
	resource."id",
	resource."workspace_id",
	resource."integration_id",
	resource."provider",
	resource."resource_type",
	resource."external_id",
	resource."name",
	resource."display_name",
	resource."status",
	resource."status_reason",
	resource."last_synced_at",
	resource."metadata",
	resource."selected_at",
	resource."created_at",
	resource."updated_at",
	'duplicate_external_id'
FROM "workspace_integration_resources" resource
WHERE EXISTS (
	SELECT 1
	FROM "workspace_integration_resources" keeper
	WHERE resource."integration_id" = keeper."integration_id"
		AND resource."resource_type" = keeper."resource_type"
		AND resource."external_id" = keeper."external_id"
		AND (
			resource."updated_at" < keeper."updated_at"
			OR (
				resource."updated_at" = keeper."updated_at"
				AND resource."id" < keeper."id"
			)
		)
)
ON CONFLICT ("id","backup_reason") DO NOTHING;--> statement-breakpoint
DELETE FROM "workspace_integration_resources" resource
USING "workspace_integration_resources" keeper
WHERE resource."integration_id" = keeper."integration_id"
	AND resource."resource_type" = keeper."resource_type"
	AND resource."external_id" = keeper."external_id"
	AND (
		resource."updated_at" < keeper."updated_at"
		OR (
			resource."updated_at" = keeper."updated_at"
			AND resource."id" < keeper."id"
		)
	);--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_integration_resources_integration_type_external_idx" ON "workspace_integration_resources" USING btree ("integration_id","resource_type","external_id");--> statement-breakpoint
ALTER TABLE "workspace_integration_resources" ADD CONSTRAINT "workspace_integration_resources_status_check" CHECK ("workspace_integration_resources"."status" IN ('available', 'permission_lost', 'archived', 'sync_failed'));--> statement-breakpoint
ALTER TABLE "workspace_integrations" ADD CONSTRAINT "workspace_integrations_status_check" CHECK ("workspace_integrations"."status" IN ('connected', 'needs_reauth', 'sync_failed', 'disconnected'));
