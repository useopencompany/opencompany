CREATE TABLE "goat"."plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'enabled' NOT NULL,
	"manifest" jsonb NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text NOT NULL,
	"source_path" text NOT NULL,
	"source_ref" text NOT NULL,
	"resolved_commit" text NOT NULL,
	"integrity" text NOT NULL,
	"stdio_mcp_servers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"install_report" jsonb NOT NULL,
	"mcp_approved_integrity" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "plugins_name_check" CHECK ("goat"."plugins"."name" ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' AND char_length("goat"."plugins"."name") <= 64 AND "goat"."plugins"."name" NOT LIKE '%--%' AND "goat"."plugins"."name" NOT LIKE '%..%'),
	CONSTRAINT "plugins_status_check" CHECK ("goat"."plugins"."status" IN ('enabled', 'disabled', 'archived')),
	CONSTRAINT "plugins_archive_status_check" CHECK (("goat"."plugins"."status" = 'archived') = ("goat"."plugins"."archived_at" IS NOT NULL)),
	CONSTRAINT "plugins_manifest_check" CHECK (jsonb_typeof("goat"."plugins"."manifest") = 'object'),
	CONSTRAINT "plugins_source_type_check" CHECK ("goat"."plugins"."source_type" IN ('github', 'skills.sh')),
	CONSTRAINT "plugins_commit_check" CHECK ("goat"."plugins"."resolved_commit" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "plugins_integrity_check" CHECK ("goat"."plugins"."integrity" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "plugins_stdio_mcp_servers_check" CHECK (jsonb_typeof("goat"."plugins"."stdio_mcp_servers") = 'array'),
	CONSTRAINT "plugins_install_report_check" CHECK (jsonb_typeof("goat"."plugins"."install_report") = 'object'),
	CONSTRAINT "plugins_mcp_approval_check" CHECK ("goat"."plugins"."mcp_approved_integrity" IS NULL OR "goat"."plugins"."mcp_approved_integrity" = "goat"."plugins"."integrity")
);
--> statement-breakpoint
CREATE TABLE "goat"."plugin_files" (
	"plugin_id" text NOT NULL,
	"path" text NOT NULL,
	"content" bytea NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	"size_bytes" integer NOT NULL,
	CONSTRAINT "goat_plugin_files_plugin_id_path_pk" PRIMARY KEY("plugin_id","path"),
	CONSTRAINT "plugin_files_size_check" CHECK ("goat"."plugin_files"."size_bytes" >= 0 AND "goat"."plugin_files"."size_bytes" <= 2097152),
	CONSTRAINT "plugin_files_content_size_check" CHECK (octet_length("goat"."plugin_files"."content") = "goat"."plugin_files"."size_bytes")
);
--> statement-breakpoint
CREATE TABLE "goat"."plugin_skills" (
	"workspace_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"skill_name" text NOT NULL,
	"skill_path" text NOT NULL,
	"skill_bundle_id" text NOT NULL,
	CONSTRAINT "goat_plugin_skills_plugin_id_skill_name_pk" PRIMARY KEY("plugin_id","skill_name"),
	CONSTRAINT "plugin_skills_name_check" CHECK ("goat"."plugin_skills"."skill_name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("goat"."plugin_skills"."skill_name") <= 64),
	CONSTRAINT "plugin_skills_path_check" CHECK (char_length("goat"."plugin_skills"."skill_path") > 0)
);
--> statement-breakpoint
CREATE TABLE "goat"."chat_session_plugins" (
	"chat_session_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_chat_session_plugins_chat_session_id_plugin_id_pk" PRIMARY KEY("chat_session_id","plugin_id")
);
--> statement-breakpoint
CREATE TABLE "goat"."workspace_plugin_data" (
	"workspace_id" text NOT NULL,
	"plugin_name" text NOT NULL,
	"blob_pathname" text NOT NULL,
	"checksum" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"lease_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_workspace_plugin_data_workspace_id_plugin_name_pk" PRIMARY KEY("workspace_id","plugin_name"),
	CONSTRAINT "workspace_plugin_data_name_check" CHECK ("goat"."workspace_plugin_data"."plugin_name" ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' AND char_length("goat"."workspace_plugin_data"."plugin_name") <= 64 AND "goat"."workspace_plugin_data"."plugin_name" NOT LIKE '%--%' AND "goat"."workspace_plugin_data"."plugin_name" NOT LIKE '%..%'),
	CONSTRAINT "workspace_plugin_data_pathname_check" CHECK (char_length("goat"."workspace_plugin_data"."blob_pathname") > 0),
	CONSTRAINT "workspace_plugin_data_checksum_check" CHECK ("goat"."workspace_plugin_data"."checksum" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "workspace_plugin_data_size_check" CHECK ("goat"."workspace_plugin_data"."size_bytes" >= 0 AND "goat"."workspace_plugin_data"."size_bytes" <= 33554432),
	CONSTRAINT "workspace_plugin_data_generation_check" CHECK ("goat"."workspace_plugin_data"."generation" >= 0),
	CONSTRAINT "workspace_plugin_data_lease_check" CHECK (("goat"."workspace_plugin_data"."lease_id" IS NULL AND "goat"."workspace_plugin_data"."lease_owner" IS NULL AND "goat"."workspace_plugin_data"."lease_expires_at" IS NULL) OR ("goat"."workspace_plugin_data"."lease_id" IS NOT NULL AND "goat"."workspace_plugin_data"."lease_owner" IS NOT NULL AND "goat"."workspace_plugin_data"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "goat"."plugins" ADD CONSTRAINT "plugins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."plugin_files" ADD CONSTRAINT "plugin_files_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "goat"."plugins"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_workspace_id_idx" ON "goat"."plugins" USING btree ("workspace_id","id");
--> statement-breakpoint
ALTER TABLE "goat"."plugin_skills" ADD CONSTRAINT "plugin_skills_workspace_plugin_fk" FOREIGN KEY ("workspace_id","plugin_id") REFERENCES "goat"."plugins"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."plugin_skills" ADD CONSTRAINT "plugin_skills_workspace_bundle_fk" FOREIGN KEY ("workspace_id","skill_bundle_id") REFERENCES "goat"."skill_bundles"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."chat_session_plugins" ADD CONSTRAINT "chat_session_plugins_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."chat_session_plugins" ADD CONSTRAINT "chat_session_plugins_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "goat"."plugins"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."workspace_plugin_data" ADD CONSTRAINT "workspace_plugin_data_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_workspace_live_name_idx" ON "goat"."plugins" USING btree ("workspace_id","name") WHERE "goat"."plugins"."status" <> 'archived';
--> statement-breakpoint
CREATE INDEX "plugins_workspace_status_updated_idx" ON "goat"."plugins" USING btree ("workspace_id","status","updated_at");
--> statement-breakpoint
CREATE INDEX "plugins_workspace_integrity_idx" ON "goat"."plugins" USING btree ("workspace_id","integrity");
--> statement-breakpoint
CREATE INDEX "plugin_skills_workspace_name_idx" ON "goat"."plugin_skills" USING btree ("workspace_id","skill_name","plugin_id");
--> statement-breakpoint
CREATE INDEX "plugin_skills_bundle_idx" ON "goat"."plugin_skills" USING btree ("skill_bundle_id");
--> statement-breakpoint
CREATE INDEX "chat_session_plugins_plugin_idx" ON "goat"."chat_session_plugins" USING btree ("plugin_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_plugin_data_blob_pathname_idx" ON "goat"."workspace_plugin_data" USING btree ("blob_pathname");
--> statement-breakpoint
CREATE INDEX "workspace_plugin_data_lease_expiry_idx" ON "goat"."workspace_plugin_data" USING btree ("lease_expires_at") WHERE "goat"."workspace_plugin_data"."lease_expires_at" IS NOT NULL;
