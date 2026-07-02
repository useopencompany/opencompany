CREATE SEQUENCE "goat"."task_display_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "goat"."chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"task_id" text,
	"debug_trace" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_chat_messages_role_check" CHECK ("goat"."chat_messages"."role" IN ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "goat"."chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"model" text NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD COLUMN "display_id" text DEFAULT 'TASK-' || nextval('goat.task_display_id_seq')::text NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."chat_messages" ADD CONSTRAINT "chat_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."chat_sessions" ADD CONSTRAINT "chat_sessions_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_chat_messages_session_created_at_idx" ON "goat"."chat_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_chat_messages_task_idx" ON "goat"."chat_messages" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "goat_chat_sessions_user_open_updated_idx" ON "goat"."chat_sessions" USING btree ("user_workos_id","closed_at","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_tasks_display_id_idx" ON "goat"."tasks" USING btree ("display_id");