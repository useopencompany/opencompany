ALTER TABLE "goat"."users" ADD COLUMN "task_view_mode" text DEFAULT 'board' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."users" ADD CONSTRAINT "goat_users_task_view_mode_check" CHECK ("task_view_mode" IN ('board', 'list'));
