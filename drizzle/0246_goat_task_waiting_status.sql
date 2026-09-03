ALTER TABLE "goat"."tasks" DROP CONSTRAINT "goat_tasks_status_check";
--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD CONSTRAINT "goat_tasks_status_check" CHECK ("goat"."tasks"."status" IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled'));
