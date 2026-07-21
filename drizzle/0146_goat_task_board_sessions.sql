-- Tasks become Linear-like board items whose runs are real chat sessions.
-- chat_sessions.task_id links a task to its single run session and doubles as
-- the discriminator that hides run sessions from chat surfaces. task_comments
-- is the agent-authored activity feed (status transitions + final result).
ALTER TABLE "goat"."chat_sessions" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "goat"."chat_sessions" ADD CONSTRAINT "goat_chat_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_chat_sessions_task_idx" ON "goat"."chat_sessions" USING btree ("task_id") WHERE "task_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD COLUMN "engine" text DEFAULT 'opencompany' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD CONSTRAINT "goat_tasks_engine_check" CHECK ("tasks"."engine" IN ('opencompany', 'codex'));--> statement-breakpoint
ALTER TABLE "goat"."task_schedules" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "goat"."task_schedules" ALTER COLUMN "planned_harness_spec" DROP NOT NULL;--> statement-breakpoint
-- Usage rows now reference chat_messages ids (the run session transcript), so
-- the old task_messages FKs must go; message_id stays as a plain text pointer.
ALTER TABLE "goat"."task_model_usage" DROP CONSTRAINT "task_model_usage_message_id_task_messages_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."task_tool_usage" DROP CONSTRAINT "task_tool_usage_message_id_task_messages_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."task_sandbox_usage" DROP CONSTRAINT "task_sandbox_usage_message_id_task_messages_id_fk";--> statement-breakpoint
CREATE TABLE "goat"."task_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"author" text DEFAULT 'agent' NOT NULL,
	"kind" text DEFAULT 'comment' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_task_comments_author_check" CHECK ("task_comments"."author" IN ('agent', 'user')),
	CONSTRAINT "goat_task_comments_kind_check" CHECK ("task_comments"."kind" IN ('status', 'result', 'comment'))
);
--> statement-breakpoint
ALTER TABLE "goat"."task_comments" ADD CONSTRAINT "goat_task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."task_comments" ADD CONSTRAINT "goat_task_comments_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_task_comments_task_created_idx" ON "goat"."task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_task_comments_user_task_created_idx" ON "goat"."task_comments" USING btree ("user_workos_id","task_id","created_at");
