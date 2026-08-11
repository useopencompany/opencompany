-- Additive only. Widens the run_events type check so the runner can append the new
-- message.part_updated Event (typed ordered text/reasoning parts, issue #1192). No existing
-- column, row, or constraint value is removed; old rows remain valid as-is.
ALTER TABLE "goat"."run_events" DROP CONSTRAINT "goat_run_events_type_check";--> statement-breakpoint
ALTER TABLE "goat"."run_events" ADD CONSTRAINT "goat_run_events_type_check" CHECK ("goat"."run_events"."type" IN ('run.queued', 'run.started', 'run.cancel_requested', 'message.created', 'message.content_updated', 'message.part_updated', 'tool.started', 'tool.completed', 'tool.failed', 'approval.requested', 'approval.resolved', 'artifact.published', 'run.paused', 'run.completed', 'run.failed', 'run.canceled')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."run_events" VALIDATE CONSTRAINT "goat_run_events_type_check";
