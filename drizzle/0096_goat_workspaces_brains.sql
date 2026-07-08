CREATE TABLE "goat"."workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"workos_organization_id" text,
	"name" text NOT NULL,
	"created_by_workos_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."workspaces" ADD CONSTRAINT "workspaces_created_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("created_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_workspaces_workos_organization_idx" ON "goat"."workspaces" USING btree ("workos_organization_id");--> statement-breakpoint
CREATE TABLE "goat"."workspace_members" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_workspace_members_role_check" CHECK ("goat"."workspace_members"."role" IN ('admin', 'member'))
);
--> statement-breakpoint
ALTER TABLE "goat"."workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."workspace_members" ADD CONSTRAINT "workspace_members_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_workspace_members_workspace_user_idx" ON "goat"."workspace_members" USING btree ("workspace_id","user_workos_id");--> statement-breakpoint
CREATE INDEX "goat_workspace_members_user_idx" ON "goat"."workspace_members" USING btree ("user_workos_id");--> statement-breakpoint
CREATE TABLE "goat"."brains" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"visibility" text DEFAULT 'workspace' NOT NULL,
	"created_by_workos_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_brains_visibility_check" CHECK ("goat"."brains"."visibility" IN ('workspace', 'restricted'))
);
--> statement-breakpoint
ALTER TABLE "goat"."brains" ADD CONSTRAINT "brains_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brains" ADD CONSTRAINT "brains_created_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("created_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brains_workspace_slug_idx" ON "goat"."brains" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "goat_brains_workspace_idx" ON "goat"."brains" USING btree ("workspace_id");--> statement-breakpoint
CREATE TABLE "goat"."brain_members" (
	"id" text PRIMARY KEY NOT NULL,
	"brain_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"added_by_workos_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."brain_members" ADD CONSTRAINT "brain_members_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_members" ADD CONSTRAINT "brain_members_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_members_brain_user_idx" ON "goat"."brain_members" USING btree ("brain_id","user_workos_id");--> statement-breakpoint
CREATE INDEX "goat_brain_members_user_idx" ON "goat"."brain_members" USING btree ("user_workos_id");--> statement-breakpoint
INSERT INTO "goat"."workspaces" ("id", "name", "created_by_workos_id")
SELECT
	'goat_ws_' || "workos_user_id",
	COALESCE(
		NULLIF(TRIM(COALESCE("first_name", '') || ' ' || COALESCE("last_name", '')), ''),
		split_part("email", '@', 1)
	) || '''s Workspace',
	"workos_user_id"
FROM "goat"."users"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "goat"."workspace_members" ("id", "workspace_id", "user_workos_id", "role")
SELECT
	'goat_wsm_' || "workos_user_id",
	'goat_ws_' || "workos_user_id",
	"workos_user_id",
	'admin'
FROM "goat"."users"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "goat"."brains" ("id", "workspace_id", "name", "slug", "visibility", "created_by_workos_id")
SELECT
	'goat_brain_' || "workos_user_id",
	'goat_ws_' || "workos_user_id",
	'General',
	'general',
	'workspace',
	"workos_user_id"
FROM "goat"."users"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "goat"."brain_folders" ADD COLUMN IF NOT EXISTS "brain_ref" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN IF NOT EXISTS "brain_ref" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_timeline_entries" ADD COLUMN IF NOT EXISTS "brain_ref" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_edges" ADD COLUMN IF NOT EXISTS "brain_ref" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_document_versions" ADD COLUMN IF NOT EXISTS "brain_ref" text;--> statement-breakpoint
UPDATE "goat"."brain_folders" SET "brain_ref" = 'goat_brain_' || "user_workos_id" WHERE "brain_ref" IS NULL;--> statement-breakpoint
UPDATE "goat"."brain_documents" SET "brain_ref" = 'goat_brain_' || "user_workos_id" WHERE "brain_ref" IS NULL;--> statement-breakpoint
UPDATE "goat"."brain_timeline_entries" SET "brain_ref" = 'goat_brain_' || "user_workos_id" WHERE "brain_ref" IS NULL;--> statement-breakpoint
UPDATE "goat"."brain_edges" SET "brain_ref" = 'goat_brain_' || "user_workos_id" WHERE "brain_ref" IS NULL;--> statement-breakpoint
UPDATE "goat"."brain_document_versions" SET "brain_ref" = 'goat_brain_' || "user_workos_id" WHERE "brain_ref" IS NULL;--> statement-breakpoint
ALTER TABLE "goat"."brain_folders" ALTER COLUMN "brain_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ALTER COLUMN "brain_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."brain_timeline_entries" ALTER COLUMN "brain_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."brain_edges" ALTER COLUMN "brain_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."brain_folders" ADD CONSTRAINT "brain_folders_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "brain_documents_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_timeline_entries" ADD CONSTRAINT "brain_timeline_entries_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_edges" ADD CONSTRAINT "brain_edges_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_document_versions" ADD CONSTRAINT "brain_document_versions_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_folders_user_path_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_folders_user_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_folders_brain_ref_path_idx" ON "goat"."brain_folders" USING btree ("brain_ref","path");--> statement-breakpoint
CREATE INDEX "goat_brain_folders_brain_ref_idx" ON "goat"."brain_folders" USING btree ("brain_ref");--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_documents_user_brain_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_documents_user_folder_brain_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_documents_user_folder_updated_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_documents_user_updated_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_documents_brain_ref_brain_id_idx" ON "goat"."brain_documents" USING btree ("brain_ref","brain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_documents_brain_ref_folder_brain_idx" ON "goat"."brain_documents" USING btree ("brain_ref","folder_path","brain_id");--> statement-breakpoint
CREATE INDEX "goat_brain_documents_brain_ref_folder_updated_idx" ON "goat"."brain_documents" USING btree ("brain_ref","folder_path","updated_at");--> statement-breakpoint
CREATE INDEX "goat_brain_documents_brain_ref_updated_idx" ON "goat"."brain_documents" USING btree ("brain_ref","updated_at");--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_timeline_entries_user_brain_at_idx";--> statement-breakpoint
CREATE INDEX "goat_brain_timeline_entries_brain_ref_brain_at_idx" ON "goat"."brain_timeline_entries" USING btree ("brain_ref","brain_id","at");--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_edges_user_from_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_edges_user_to_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_edges_user_relation_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_brain_edges_unique_idx";--> statement-breakpoint
CREATE INDEX "goat_brain_edges_brain_ref_from_idx" ON "goat"."brain_edges" USING btree ("brain_ref","from_brain_id");--> statement-breakpoint
CREATE INDEX "goat_brain_edges_brain_ref_to_idx" ON "goat"."brain_edges" USING btree ("brain_ref","to_brain_id");--> statement-breakpoint
CREATE INDEX "goat_brain_edges_brain_ref_relation_idx" ON "goat"."brain_edges" USING btree ("brain_ref","relation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_edges_unique_idx" ON "goat"."brain_edges" USING btree ("brain_ref","document_id","from_brain_id","to_brain_id","relation_type","source_kind");
