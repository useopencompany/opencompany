ALTER TABLE "goat"."workflows" ADD COLUMN "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."workflows" ADD CONSTRAINT "goat_workflows_trigger_check" CHECK ("trigger" IN ('manual', 'slack', 'linear', 'schedule'));--> statement-breakpoint
UPDATE "goat"."workflows"
SET "steps" = jsonb_build_array(jsonb_build_object(
	'id', 'step-' || substr(md5("id"), 1, 8),
	'title', '',
	'model', "model",
	'instructions', "instructions"
))
WHERE "instructions" <> '' AND "steps" = '[]'::jsonb;
