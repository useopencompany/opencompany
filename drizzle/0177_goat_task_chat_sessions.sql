ALTER TABLE "goat"."chat_sessions" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."chat_sessions" ADD CONSTRAINT "goat_chat_sessions_kind_check" CHECK ("goat"."chat_sessions"."kind" IN ('chat', 'task'));--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD CONSTRAINT "goat_tasks_session_id_goat_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_tasks_session_idx" ON "goat"."tasks" USING btree ("session_id") WHERE "goat"."tasks"."session_id" IS NOT NULL;
