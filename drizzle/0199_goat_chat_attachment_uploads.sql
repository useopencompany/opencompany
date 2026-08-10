-- Additive, actor-scoped upload registry for canonical Chat. Provider locators never cross the
-- v1 protocol, and a successful Message command claims each upload exactly once.
CREATE TABLE "goat"."chat_attachment_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"format" text NOT NULL,
	"media_type" text NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob_pathname" text NOT NULL,
	"blob_url" text NOT NULL,
	"extracted_text" text,
	"claimed_message_id" text,
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_chat_attachment_uploads_format_check" CHECK ("goat"."chat_attachment_uploads"."format" IN ('pdf', 'docx', 'xlsx', 'srt', 'csv', 'tsv', 'json', 'text', 'image')),
	CONSTRAINT "goat_chat_attachment_uploads_size_check" CHECK ("goat"."chat_attachment_uploads"."size_bytes" > 0 AND "goat"."chat_attachment_uploads"."size_bytes" <= 20971520),
	CONSTRAINT "goat_chat_attachment_uploads_lifecycle_check" CHECK (("goat"."chat_attachment_uploads"."claimed_at" IS NULL AND "goat"."chat_attachment_uploads"."claimed_message_id" IS NULL) OR ("goat"."chat_attachment_uploads"."claimed_at" IS NOT NULL AND "goat"."chat_attachment_uploads"."claimed_message_id" IS NOT NULL)),
	CONSTRAINT "goat_chat_attachment_uploads_expiry_check" CHECK ("goat"."chat_attachment_uploads"."expires_at" > "goat"."chat_attachment_uploads"."created_at")
);--> statement-breakpoint
ALTER TABLE "goat"."chat_attachment_uploads" ADD CONSTRAINT "chat_attachment_uploads_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."chat_attachment_uploads" ADD CONSTRAINT "chat_attachment_uploads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_chat_attachment_uploads_actor_unclaimed_idx" ON "goat"."chat_attachment_uploads" USING btree ("user_workos_id","workspace_id","expires_at") WHERE "claimed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "goat_chat_attachment_uploads_claimed_message_idx" ON "goat"."chat_attachment_uploads" USING btree ("claimed_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_chat_attachment_uploads_blob_pathname_idx" ON "goat"."chat_attachment_uploads" USING btree ("blob_pathname");
