CREATE TABLE "brain_file_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope" text NOT NULL,
	"agent_id" text,
	"path" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"operation" text NOT NULL,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brain_file_versions" ADD CONSTRAINT "brain_file_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brain_file_versions_lookup_idx" ON "brain_file_versions" USING btree ("workspace_id","scope","path","created_at");--> statement-breakpoint
CREATE INDEX "brain_file_versions_session_idx" ON "brain_file_versions" USING btree ("workspace_id","session_id");