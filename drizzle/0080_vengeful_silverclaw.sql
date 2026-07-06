CREATE TABLE "goat"."integration_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_integration_resources_provider_check" CHECK ("goat"."integration_resources"."provider" IN ('gmail', 'google_calendar', 'linear', 'github')),
	CONSTRAINT "goat_integration_resources_status_check" CHECK ("goat"."integration_resources"."status" IN ('available', 'permission_lost', 'archived', 'sync_failed'))
);
--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" DROP CONSTRAINT "goat_integration_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integrations" DROP CONSTRAINT "goat_integrations_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "integration_resources_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."integration_resources" ADD CONSTRAINT "goat_integration_resources_integration_user_provider_fk" FOREIGN KEY ("integration_id","user_workos_id","provider") REFERENCES "goat"."integrations"("id","user_workos_id","provider") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_integration_resources_user_provider_type_idx" ON "goat"."integration_resources" USING btree ("user_workos_id","provider","resource_type");--> statement-breakpoint
CREATE INDEX "goat_integration_resources_integration_idx" ON "goat"."integration_resources" USING btree ("integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_integration_resources_integration_type_external_idx" ON "goat"."integration_resources" USING btree ("integration_id","resource_type","external_id");--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar', 'linear', 'github'));--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar', 'linear', 'github'));