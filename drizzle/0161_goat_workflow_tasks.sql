ALTER TABLE "goat"."tasks" ADD COLUMN IF NOT EXISTS "workflow_id" text;
--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD COLUMN IF NOT EXISTS "workflow_brain_ref" text;
--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD COLUMN IF NOT EXISTS "reported_outcome" text;
--> statement-breakpoint
ALTER TABLE "goat"."tasks" ADD COLUMN IF NOT EXISTS "outcome_comment" text;
--> statement-breakpoint
ALTER TABLE "goat"."tasks"
	ADD CONSTRAINT "goat_tasks_reported_outcome_check"
		CHECK ("reported_outcome" IS NULL OR "reported_outcome" IN ('done', 'needs_attention')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "goat"."tasks"
	VALIDATE CONSTRAINT "goat_tasks_reported_outcome_check";
