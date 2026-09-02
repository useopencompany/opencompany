-- Durable reservations make keyed attachment uploads replay-safe. Rows remain as tombstones after
-- cleanup so a key cannot silently acquire a new meaning while its actor and workspace exist.
CREATE TABLE "goat"."chat_attachment_upload_commands" (
	"command_id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"attachment_id" text NOT NULL,
	"blob_pathname" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"cleaned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_chat_attachment_upload_commands_request_hash_check" CHECK ("goat"."chat_attachment_upload_commands"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "goat_chat_attachment_upload_commands_key_length_check" CHECK (length("goat"."chat_attachment_upload_commands"."idempotency_key") BETWEEN 1 AND 200),
	CONSTRAINT "goat_chat_attachment_upload_commands_key_ascii_check" CHECK ("goat"."chat_attachment_upload_commands"."idempotency_key" ~ '^[!-~]+$'),
	CONSTRAINT "goat_chat_attachment_upload_commands_expiry_check" CHECK ("goat"."chat_attachment_upload_commands"."expires_at" > "goat"."chat_attachment_upload_commands"."created_at"),
	CONSTRAINT "goat_chat_attachment_upload_commands_lifecycle_check" CHECK ("goat"."chat_attachment_upload_commands"."cleaned_at" IS NULL OR "goat"."chat_attachment_upload_commands"."completed_at" IS NULL OR "goat"."chat_attachment_upload_commands"."cleaned_at" >= "goat"."chat_attachment_upload_commands"."completed_at")
);--> statement-breakpoint
ALTER TABLE "goat"."chat_attachment_upload_commands" ADD CONSTRAINT "chat_attachment_upload_commands_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."chat_attachment_upload_commands" ADD CONSTRAINT "chat_attachment_upload_commands_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_chat_attachment_upload_commands_actor_key_idx" ON "goat"."chat_attachment_upload_commands" USING btree ("user_workos_id","workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_chat_attachment_upload_commands_attachment_idx" ON "goat"."chat_attachment_upload_commands" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_chat_attachment_upload_commands_blob_pathname_idx" ON "goat"."chat_attachment_upload_commands" USING btree ("blob_pathname");--> statement-breakpoint
CREATE INDEX "goat_chat_attachment_upload_commands_expiry_idx" ON "goat"."chat_attachment_upload_commands" USING btree ("expires_at","command_id") WHERE "cleaned_at" IS NULL;--> statement-breakpoint
CREATE INDEX "goat_chat_attachment_uploads_cleanup_expiry_idx" ON "goat"."chat_attachment_uploads" USING btree ("expires_at","id") WHERE "claimed_at" IS NULL;
