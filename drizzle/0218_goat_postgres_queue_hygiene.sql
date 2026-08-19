-- Retention is executed by the runner in small SKIP LOCKED batches:
-- terminal-run event logs after 30 days and terminal queue rows after 90 days.
-- Chat transcripts and read models live in separate tables and are retained.
CREATE INDEX "opencompany_task_events_retention_idx"
ON "goat"."task_events" USING btree ("created_at", "id");
--> statement-breakpoint
CREATE INDEX "opencompany_run_events_retention_idx"
ON "goat"."run_events" USING btree ("created_at", "id");
--> statement-breakpoint
CREATE INDEX "opencompany_codex_chat_events_retention_idx"
ON "goat"."codex_chat_events" USING btree ("created_at", "id");
--> statement-breakpoint
CREATE INDEX "opencompany_codex_chat_turns_retention_idx"
ON "goat"."codex_chat_turns" USING btree ("completed_at", "id")
WHERE "status" IN ('completed', 'failed', 'interrupted') AND "completed_at" IS NOT NULL;
--> statement-breakpoint
-- Lease claims and heartbeats make codex_chat_turns UPDATE-heavy. Fixed thresholds
-- keep vacuum cadence responsive before dead tuples can dominate the queue scan.
ALTER TABLE "goat"."codex_chat_turns" SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 500,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 500
);
--> statement-breakpoint
ALTER TABLE "goat"."run_events" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 500,
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_analyze_threshold = 500
);
--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_events" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 500,
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_analyze_threshold = 500
);
--> statement-breakpoint
ALTER TABLE "goat"."task_events" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 500,
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_analyze_threshold = 500
);
