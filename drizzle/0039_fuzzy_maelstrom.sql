CREATE TABLE "workspace_skill_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"source_type" text DEFAULT 'github' NOT NULL,
	"source_url" text NOT NULL,
	"requested_ref" text NOT NULL,
	"skill_path" text DEFAULT '' NOT NULL,
	"resolved_commit" text NOT NULL,
	"integrity" text NOT NULL,
	"files" jsonb NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"last_resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_skill_snapshots" ADD CONSTRAINT "workspace_skill_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_skill_snapshots_source_idx" ON "workspace_skill_snapshots" USING btree ("workspace_id","source_url","requested_ref","skill_path");--> statement-breakpoint
CREATE INDEX "workspace_skill_snapshots_skill_id_idx" ON "workspace_skill_snapshots" USING btree ("workspace_id","skill_id");