ALTER TABLE "goat"."plugins" ADD COLUMN IF NOT EXISTS "events" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "goat"."plugins" ADD COLUMN IF NOT EXISTS "event_modes" jsonb NOT NULL DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "goat"."plugins" DROP CONSTRAINT IF EXISTS "plugins_events_check";--> statement-breakpoint
ALTER TABLE "goat"."plugins" ADD CONSTRAINT "plugins_events_check" CHECK (jsonb_typeof("goat"."plugins"."events") = 'array') NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."plugins" DROP CONSTRAINT IF EXISTS "plugins_event_modes_check";--> statement-breakpoint
ALTER TABLE "goat"."plugins" ADD CONSTRAINT "plugins_event_modes_check" CHECK (jsonb_typeof("goat"."plugins"."event_modes") = 'object') NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."workflow_event_runs" DROP CONSTRAINT IF EXISTS "opencompany_workflow_event_runs_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."workflow_event_runs" ADD CONSTRAINT "opencompany_workflow_event_runs_provider_check" CHECK ("goat"."workflow_event_runs"."provider" ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' AND char_length("goat"."workflow_event_runs"."provider") <= 64) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."plugins" VALIDATE CONSTRAINT "plugins_events_check";--> statement-breakpoint
ALTER TABLE "goat"."plugins" VALIDATE CONSTRAINT "plugins_event_modes_check";--> statement-breakpoint
ALTER TABLE "goat"."workflow_event_runs" VALIDATE CONSTRAINT "opencompany_workflow_event_runs_provider_check";
