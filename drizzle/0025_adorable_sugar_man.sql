CREATE TABLE "workspace_integration_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"encrypted_payload" jsonb NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_integration_credentials" ADD CONSTRAINT "workspace_integration_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_integration_credentials" ADD CONSTRAINT "workspace_integration_credentials_integration_workspace_provider_fk" FOREIGN KEY ("integration_id","workspace_id","provider") REFERENCES "public"."workspace_integrations"("id","workspace_id","provider") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_integration_credentials_workspace_provider_idx" ON "workspace_integration_credentials" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE INDEX "workspace_integration_credentials_integration_idx" ON "workspace_integration_credentials" USING btree ("integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_integration_credentials_integration_kind_idx" ON "workspace_integration_credentials" USING btree ("integration_id","kind");
