ALTER TABLE "goat"."users" ADD COLUMN "task_time_range" text DEFAULT '7d' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."users" ADD CONSTRAINT "opencompany_users_task_time_range_check" CHECK ("task_time_range" IN ('24h', '2d', '7d', '30d', '90d', 'all'));
