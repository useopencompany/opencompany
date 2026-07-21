-- 0146 shared a migration clock value with an already-applied dev migration, so
-- some databases recorded that timestamp without receiving the session-backed
-- task schema. Repair those additive primitives idempotently before removing
-- the legacy harness columns and tables.
ALTER TABLE "goat"."chat_sessions" ADD COLUMN IF NOT EXISTS "task_id" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'goat_chat_sessions_task_id_tasks_id_fk'
      AND conrelid = 'goat.chat_sessions'::regclass
  ) THEN
    ALTER TABLE "goat"."chat_sessions"
      ADD CONSTRAINT "goat_chat_sessions_task_id_tasks_id_fk"
      FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_chat_sessions_task_idx" ON "goat"."chat_sessions" USING btree ("task_id") WHERE "task_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD COLUMN IF NOT EXISTS "engine" text DEFAULT 'opencompany' NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'goat_tasks_engine_check'
      AND conrelid = 'goat.tasks'::regclass
  ) THEN
    ALTER TABLE "goat"."tasks"
      ADD CONSTRAINT "goat_tasks_engine_check"
      CHECK ("engine" IN ('opencompany', 'codex'));
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "goat"."task_schedules" ADD COLUMN IF NOT EXISTS "model" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."task_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"author" text DEFAULT 'agent' NOT NULL,
	"kind" text DEFAULT 'comment' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "goat"."tasks"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "goat_task_comments_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "goat_task_comments_author_check" CHECK ("author" IN ('agent', 'user')),
	CONSTRAINT "goat_task_comments_kind_check" CHECK ("kind" IN ('status', 'result', 'comment'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_task_comments_task_created_idx" ON "goat"."task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_task_comments_user_task_created_idx" ON "goat"."task_comments" USING btree ("user_workos_id","task_id","created_at");--> statement-breakpoint
ALTER TABLE "goat"."tasks" DROP CONSTRAINT "goat_tasks_stage_check";--> statement-breakpoint
ALTER TABLE "goat"."tasks" DROP COLUMN "stage";--> statement-breakpoint
ALTER TABLE "goat"."tasks" DROP COLUMN "harness_spec";--> statement-breakpoint
ALTER TABLE "goat"."tasks" DROP COLUMN "debug_trace";--> statement-breakpoint
ALTER TABLE "goat"."tasks" DROP COLUMN "sandbox_id";--> statement-breakpoint
ALTER TABLE "goat"."tasks" DROP COLUMN "codex_engine_session_id";--> statement-breakpoint
ALTER TABLE "goat"."task_schedules" DROP COLUMN "planned_harness_spec";--> statement-breakpoint
ALTER TABLE "goat"."task_model_usage" DROP CONSTRAINT IF EXISTS "task_model_usage_message_id_task_messages_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."task_tool_usage" DROP CONSTRAINT IF EXISTS "task_tool_usage_message_id_task_messages_id_fk";--> statement-breakpoint
ALTER TABLE "goat"."task_sandbox_usage" DROP CONSTRAINT IF EXISTS "task_sandbox_usage_message_id_task_messages_id_fk";--> statement-breakpoint
DROP TABLE "goat"."task_events";--> statement-breakpoint
DROP TABLE "goat"."task_messages";
