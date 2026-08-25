CREATE TABLE "goat"."skill_bundles" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"integrity" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"license" text,
	"compatibility" text,
	"metadata" jsonb,
	"allowed_tools" text,
	"body" text NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text NOT NULL,
	"source_path" text NOT NULL,
	"source_ref" text NOT NULL,
	"resolved_commit" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_bundles_source_type_check" CHECK ("goat"."skill_bundles"."source_type" IN ('github', 'skills.sh')),
	CONSTRAINT "skill_bundles_integrity_check" CHECK ("goat"."skill_bundles"."integrity" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "skill_bundles_commit_check" CHECK ("goat"."skill_bundles"."resolved_commit" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "goat"."skill_bundle_files" (
	"bundle_id" text NOT NULL,
	"path" text NOT NULL,
	"content" bytea NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	"size_bytes" integer NOT NULL,
	CONSTRAINT "goat_skill_bundle_files_bundle_id_path_pk" PRIMARY KEY("bundle_id","path"),
	CONSTRAINT "skill_bundle_files_size_check" CHECK ("goat"."skill_bundle_files"."size_bytes" >= 0),
	CONSTRAINT "skill_bundle_files_content_size_check" CHECK (octet_length("goat"."skill_bundle_files"."content") = "goat"."skill_bundle_files"."size_bytes")
);
--> statement-breakpoint
CREATE TABLE "goat"."skill_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"bundle_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "goat"."skill_bundles" ADD CONSTRAINT "skill_bundles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."skill_bundle_files" ADD CONSTRAINT "skill_bundle_files_bundle_id_skill_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "goat"."skill_bundles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."skill_installations" ADD CONSTRAINT "skill_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_bundles_workspace_integrity_idx" ON "goat"."skill_bundles" USING btree ("workspace_id","integrity");
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_bundles_workspace_id_idx" ON "goat"."skill_bundles" USING btree ("workspace_id","id");
--> statement-breakpoint
CREATE INDEX "skill_bundles_workspace_name_idx" ON "goat"."skill_bundles" USING btree ("workspace_id","name","created_at");
--> statement-breakpoint
ALTER TABLE "goat"."skill_installations" ADD CONSTRAINT "skill_installations_workspace_bundle_fk" FOREIGN KEY ("workspace_id","bundle_id") REFERENCES "goat"."skill_bundles"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_installations_workspace_live_name_idx" ON "goat"."skill_installations" USING btree ("workspace_id","name") WHERE "goat"."skill_installations"."archived_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "skill_installations_workspace_updated_idx" ON "goat"."skill_installations" USING btree ("workspace_id","archived_at","updated_at");
--> statement-breakpoint
CREATE INDEX "skill_installations_bundle_idx" ON "goat"."skill_installations" USING btree ("bundle_id");
