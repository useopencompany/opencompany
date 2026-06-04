-- Drop the legacy per-resource sync-job tables. Migration 0038 backfilled any
-- in-flight rows from these into the unified workspace_sync_jobs outbox BEFORE
-- this drop, so no pending GitHub syncs are lost. The Drizzle schema already
-- removed these tables; this migration reconciles the database with it (0038's
-- snapshot dropped them but its SQL never did, leaving DB/schema drift).
DROP TABLE IF EXISTS "agent_sync_jobs";--> statement-breakpoint
DROP TABLE IF EXISTS "brain_sync_jobs";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_file_sync_jobs";
