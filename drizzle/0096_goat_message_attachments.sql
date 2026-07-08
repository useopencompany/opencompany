CREATE TABLE "goat"."message_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"chat_session_id" text,
	"chat_message_id" text,
	"task_id" text,
	"task_message_id" text,
	"kind" text NOT NULL,
	"media_type" text NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob_pathname" text NOT NULL,
	"blob_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_message_attachments_kind_check" CHECK ("goat"."message_attachments"."kind" IN ('image', 'pdf', 'text')),
	CONSTRAINT "goat_message_attachments_parent_check" CHECK (
		(
			"chat_session_id" IS NOT NULL
			AND "chat_message_id" IS NOT NULL
			AND "task_id" IS NULL
			AND "task_message_id" IS NULL
		)
		OR (
			"chat_session_id" IS NULL
			AND "chat_message_id" IS NULL
			AND "task_id" IS NOT NULL
			AND "task_message_id" IS NOT NULL
		)
	),
	CONSTRAINT "goat_message_attachments_size_check" CHECK ("goat"."message_attachments"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "goat"."message_attachments" ADD CONSTRAINT "message_attachments_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."message_attachments" ADD CONSTRAINT "message_attachments_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."message_attachments" ADD CONSTRAINT "message_attachments_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "goat"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."message_attachments" ADD CONSTRAINT "message_attachments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."message_attachments" ADD CONSTRAINT "message_attachments_task_message_id_task_messages_id_fk" FOREIGN KEY ("task_message_id") REFERENCES "goat"."task_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "goat_message_attachments_user_created_idx" ON "goat"."message_attachments" USING btree ("user_workos_id","created_at");
--> statement-breakpoint
CREATE INDEX "goat_message_attachments_chat_message_idx" ON "goat"."message_attachments" USING btree ("chat_message_id");
--> statement-breakpoint
CREATE INDEX "goat_message_attachments_chat_session_idx" ON "goat"."message_attachments" USING btree ("chat_session_id");
--> statement-breakpoint
CREATE INDEX "goat_message_attachments_task_message_idx" ON "goat"."message_attachments" USING btree ("task_message_id");
--> statement-breakpoint
CREATE INDEX "goat_message_attachments_task_idx" ON "goat"."message_attachments" USING btree ("task_id");
