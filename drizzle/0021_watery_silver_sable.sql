CREATE TABLE "workspace_integration_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"provider" text NOT NULL,
	"resource_type" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"selected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"account_name" text,
	"account_type" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "workspace_integrations" (
	"id",
	"workspace_id",
	"provider",
	"external_id",
	"account_name",
	"account_type",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"workspace_id",
	'github',
	"installation_id",
	"account_login",
	"account_type",
	"created_at",
	"updated_at"
FROM "workspace_github_integration_installations";
--> statement-breakpoint
INSERT INTO "workspace_integration_resources" (
	"id",
	"workspace_id",
	"integration_id",
	"provider",
	"resource_type",
	"external_id",
	"name",
	"display_name",
	"metadata",
	"selected_at",
	"created_at",
	"updated_at"
)
SELECT
	repository."id",
	repository."workspace_id",
	installation."id",
	'github',
	'repository',
	repository."github_repo_id",
	repository."full_name",
	repository."full_name",
	jsonb_build_object(
		'defaultBranch', repository."default_branch",
		'private', repository."private"
	),
	repository."selected_at",
	repository."created_at",
	repository."updated_at"
FROM "workspace_github_integration_repositories" repository
INNER JOIN "workspace_github_integration_installations" installation
	ON installation."workspace_id" = repository."workspace_id"
	AND installation."installation_id" = repository."installation_id";
--> statement-breakpoint
DROP TABLE "workspace_github_integration_installations" CASCADE;--> statement-breakpoint
DROP TABLE "workspace_github_integration_repositories" CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_integration_resources" ADD CONSTRAINT "workspace_integration_resources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_integration_resources" ADD CONSTRAINT "workspace_integration_resources_integration_id_workspace_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."workspace_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_integrations" ADD CONSTRAINT "workspace_integrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_integration_resources_workspace_provider_type_idx" ON "workspace_integration_resources" USING btree ("workspace_id","provider","resource_type");--> statement-breakpoint
CREATE INDEX "workspace_integration_resources_integration_idx" ON "workspace_integration_resources" USING btree ("integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_integration_resources_workspace_provider_type_name_idx" ON "workspace_integration_resources" USING btree ("workspace_id","provider","resource_type","name");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_integration_resources_workspace_provider_type_external_idx" ON "workspace_integration_resources" USING btree ("workspace_id","provider","resource_type","external_id");--> statement-breakpoint
CREATE INDEX "workspace_integrations_workspace_provider_idx" ON "workspace_integrations" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_integrations_workspace_provider_external_idx" ON "workspace_integrations" USING btree ("workspace_id","provider","external_id");
