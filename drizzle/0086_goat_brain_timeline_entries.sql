CREATE TABLE "goat"."brain_timeline_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"brain_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"source_ref" text DEFAULT '' NOT NULL,
	"source_title" text,
	"summary" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."brain_timeline_entries" ADD CONSTRAINT "brain_timeline_entries_document_id_brain_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "goat"."brain_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_timeline_entries" ADD CONSTRAINT "brain_timeline_entries_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_brain_timeline_entries_user_brain_at_idx" ON "goat"."brain_timeline_entries" USING btree ("user_workos_id","brain_id","at");--> statement-breakpoint
CREATE INDEX "goat_brain_timeline_entries_document_at_idx" ON "goat"."brain_timeline_entries" USING btree ("document_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_timeline_entries_dedup_idx" ON "goat"."brain_timeline_entries" USING btree ("document_id","at","summary","source_ref");
