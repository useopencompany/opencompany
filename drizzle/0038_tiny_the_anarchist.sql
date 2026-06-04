-- Backfill any in-flight rows from the legacy per-resource sync-job tables into
-- the unified workspace_sync_jobs outbox BEFORE dropping them, so pending GitHub
-- syncs are flushed through the new projector instead of being orphaned. Rows
-- are reset to a fresh pending state (attempts 0, due now). ON CONFLICT guards
-- against any path already tracked by the new pipeline.
INSERT INTO "workspace_sync_jobs"
  ("workspace_id","repo_path","source_kind","source_ref","operation","desired_hash","previous_path","previous_blob_sha","status","attempts","next_run_at","updated_at")
SELECT
  "workspace_id",
  'brain/' || "path",
  'brain',
  NULL,
  "operation",
  "desired_hash",
  CASE WHEN "previous_path" IS NOT NULL THEN 'brain/' || "previous_path" ELSE NULL END,
  "previous_blob_sha",
  'pending',
  0,
  now(),
  now()
FROM "brain_sync_jobs"
ON CONFLICT ("workspace_id","repo_path") DO NOTHING;
--> statement-breakpoint
INSERT INTO "workspace_sync_jobs"
  ("workspace_id","repo_path","source_kind","source_ref","operation","desired_hash","previous_path","previous_blob_sha","status","attempts","next_run_at","updated_at")
SELECT
  "workspace_id",
  "path",
  'agent_file',
  NULL,
  "operation",
  "desired_hash",
  "previous_path",
  "previous_blob_sha",
  'pending',
  0,
  now(),
  now()
FROM "agent_file_sync_jobs"
ON CONFLICT ("workspace_id","repo_path") DO NOTHING;
--> statement-breakpoint
INSERT INTO "workspace_sync_jobs"
  ("workspace_id","repo_path","source_kind","source_ref","operation","desired_hash","previous_path","previous_blob_sha","status","attempts","next_run_at","updated_at")
SELECT
  "workspace_id",
  "path",
  'agent',
  "agent_id",
  'upsert',
  "desired_hash",
  "previous_path",
  "previous_blob_sha",
  'pending',
  0,
  now(),
  now()
FROM "agent_sync_jobs"
ON CONFLICT ("workspace_id","repo_path") DO NOTHING;
--> statement-breakpoint
DROP TABLE "agent_file_sync_jobs" CASCADE;--> statement-breakpoint
DROP TABLE "agent_sync_jobs" CASCADE;--> statement-breakpoint
DROP TABLE "brain_sync_jobs" CASCADE;
