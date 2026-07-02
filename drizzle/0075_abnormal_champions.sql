CREATE TABLE "goat"."integration_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"encrypted_payload" jsonb NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_integration_credentials_provider_check" CHECK ("goat"."integration_credentials"."provider" IN ('gmail', 'google_calendar')),
	CONSTRAINT "goat_integration_credentials_kind_check" CHECK ("goat"."integration_credentials"."kind" IN ('oauth_token'))
);
--> statement-breakpoint
CREATE TABLE "goat"."integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"connection_label" text,
	"account_name" text,
	"account_email" text,
	"account_type" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"status_reason" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_integrations_provider_check" CHECK ("goat"."integrations"."provider" IN ('gmail', 'google_calendar')),
	CONSTRAINT "goat_integrations_status_check" CHECK ("goat"."integrations"."status" IN ('connected', 'needs_reauth', 'sync_failed', 'disconnected'))
);
--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "integration_credentials_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."integration_credentials" ADD CONSTRAINT "goat_integration_credentials_integration_user_provider_fk" FOREIGN KEY ("integration_id","user_workos_id","provider") REFERENCES "goat"."integrations"("id","user_workos_id","provider") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "integrations_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_integration_credentials_user_provider_idx" ON "goat"."integration_credentials" USING btree ("user_workos_id","provider");--> statement-breakpoint
CREATE INDEX "goat_integration_credentials_integration_idx" ON "goat"."integration_credentials" USING btree ("integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_integration_credentials_integration_kind_idx" ON "goat"."integration_credentials" USING btree ("integration_id","kind");--> statement-breakpoint
CREATE INDEX "goat_integrations_user_provider_idx" ON "goat"."integrations" USING btree ("user_workos_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_integrations_user_provider_external_idx" ON "goat"."integrations" USING btree ("user_workos_id","provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_integrations_id_user_provider_idx" ON "goat"."integrations" USING btree ("id","user_workos_id","provider");