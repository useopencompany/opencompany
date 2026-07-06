ALTER TABLE "goat"."tasks" DROP CONSTRAINT "goat_tasks_status_check";--> statement-breakpoint
ALTER TABLE "goat"."tasks" DROP CONSTRAINT "goat_tasks_stage_check";--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD CONSTRAINT "goat_tasks_status_check" CHECK ("goat"."tasks"."status" IN ('queued', 'running', 'succeeded', 'failed', 'canceled'));--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD CONSTRAINT "goat_tasks_stage_check" CHECK ("goat"."tasks"."stage" IN ('queued', 'planning', 'sandboxing', 'running', 'completed', 'failed', 'canceled'));
