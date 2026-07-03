CREATE TABLE "goat"."brain_document_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"document_id" text,
	"task_id" text,
	"brain_id" text NOT NULL,
	"folder_path" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"operation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_brain_document_versions_operation_check" CHECK ("goat"."brain_document_versions"."operation" IN ('overwrite', 'delete'))
);
--> statement-breakpoint
CREATE TABLE "goat"."brain_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"brain_id" text NOT NULL,
	"folder_path" text NOT NULL,
	"title" text,
	"content" text DEFAULT '' NOT NULL,
	"related" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goat"."brain_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"path" text NOT NULL,
	"source" text DEFAULT 'custom' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_brain_folders_source_check" CHECK ("goat"."brain_folders"."source" IN ('system', 'custom'))
);
--> statement-breakpoint
ALTER TABLE "goat"."brain_document_versions" ADD CONSTRAINT "brain_document_versions_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_document_versions" ADD CONSTRAINT "brain_document_versions_document_id_brain_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "goat"."brain_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "brain_documents_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_folders" ADD CONSTRAINT "brain_folders_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_brain_document_versions_user_document_created_idx" ON "goat"."brain_document_versions" USING btree ("user_workos_id","document_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_brain_document_versions_user_task_created_idx" ON "goat"."brain_document_versions" USING btree ("user_workos_id","task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_documents_user_brain_id_idx" ON "goat"."brain_documents" USING btree ("user_workos_id","brain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_documents_user_folder_brain_idx" ON "goat"."brain_documents" USING btree ("user_workos_id","folder_path","brain_id");--> statement-breakpoint
CREATE INDEX "goat_brain_documents_user_folder_updated_idx" ON "goat"."brain_documents" USING btree ("user_workos_id","folder_path","updated_at");--> statement-breakpoint
CREATE INDEX "goat_brain_documents_user_updated_idx" ON "goat"."brain_documents" USING btree ("user_workos_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_folders_user_path_idx" ON "goat"."brain_folders" USING btree ("user_workos_id","path");--> statement-breakpoint
CREATE INDEX "goat_brain_folders_user_idx" ON "goat"."brain_folders" USING btree ("user_workos_id");