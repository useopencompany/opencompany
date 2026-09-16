-- Retires the legacy Brain. The product moved to the Wiki: `legacy_brain_enabled`
-- has been false for every workspace since the cutover, no Brain source is
-- enabled, and nothing has written to these tables since then.
--
-- Rollback: recreating the tables is not enough — the rows are gone. Restore
-- from a Neon branch taken before this migration ran.

-- Columns on retained tables that only existed to point at Brain rows.
ALTER TABLE goat.credit_ledger DROP COLUMN IF EXISTS ingest_job_id;
ALTER TABLE goat.gmail_message_events DROP COLUMN IF EXISTS source_item_id;
ALTER TABLE goat.wiki_ingest_jobs DROP CONSTRAINT IF EXISTS opencompany_wiki_ingest_jobs_import_target_check;
ALTER TABLE goat.wiki_ingest_jobs DROP COLUMN IF EXISTS import_run_id;
ALTER TABLE goat.wiki_ingest_jobs ADD CONSTRAINT opencompany_wiki_ingest_jobs_import_target_check
  CHECK ((source_provider = 'opencompany-import' AND integration_id IS NULL)
      OR (source_provider <> 'opencompany-import' AND integration_id IS NOT NULL));
--> statement-breakpoint

-- The ingestion-reservation ledger is wiki-only now. Consumed Brain rows are
-- kept: they carry settled billing history and nothing reads a consumed row, so
-- deleting them would lose provenance for no benefit. Their source pointer goes
-- with the table it referenced. The "exactly one source kind" check has nothing
-- left to enforce once there is a single source column.
ALTER TABLE goat.workspace_ingestion_reservations DROP CONSTRAINT IF EXISTS opencompany_ingestion_reservations_source_kind_check;
ALTER TABLE goat.workspace_ingestion_reservations DROP COLUMN IF EXISTS source_item_id;
--> statement-breakpoint

-- Knowledge commands are wiki-only now.
DELETE FROM goat.knowledge_command_idempotency
  WHERE operation IN ('brain_document.create', 'brain_asset.create', 'brain_asset.replace', 'brain_import.start');
--> statement-breakpoint
ALTER TABLE goat.knowledge_command_idempotency DROP CONSTRAINT IF EXISTS goat_knowledge_command_idempotency_operation_check;
ALTER TABLE goat.knowledge_command_idempotency ADD CONSTRAINT goat_knowledge_command_idempotency_operation_check
  CHECK (operation IN ('wiki_page.create', 'wiki_timeline.create'));
--> statement-breakpoint

-- Sessions and tasks no longer pin a Brain, and no task can ask for a Brain report.
ALTER TABLE goat.codex_chat_sessions DROP COLUMN IF EXISTS brain_ref;
ALTER TABLE goat.tasks DROP COLUMN IF EXISTS workflow_brain_ref;
UPDATE goat.tasks
SET harness_spec = jsonb_set(harness_spec, '{resultMode}', '"assistant_final"')
WHERE harness_spec ? 'resultMode' AND harness_spec->>'resultMode' <> 'assistant_final';
--> statement-breakpoint

-- Brain-only provider event buffers. Their only writer and reader were the Brain
-- flush workers, which this change removes.
DROP TABLE IF EXISTS goat.slack_message_events;
DROP TABLE IF EXISTS goat.linear_issue_events;
DROP TABLE IF EXISTS goat.github_pull_request_events;
DROP TABLE IF EXISTS goat.hubspot_object_events;
DROP TABLE IF EXISTS goat.attio_object_events;
DROP TABLE IF EXISTS goat.fathom_pending_meetings;
DROP TABLE IF EXISTS goat.fathom_sync_state;
DROP TABLE IF EXISTS goat.google_drive_file_states;
DROP TABLE IF EXISTS goat.google_drive_watch_channels;
DROP TABLE IF EXISTS goat.google_drive_sync_cursors;
--> statement-breakpoint

-- The Brain itself, dependants before their parents so every FK unwinds without
-- CASCADE (an explicit order fails loudly if a new dependant ever appears).
DROP TABLE IF EXISTS goat.brain_tool_runs;
DROP TABLE IF EXISTS goat.brain_document_embeddings;
DROP TABLE IF EXISTS goat.brain_document_versions;
DROP TABLE IF EXISTS goat.brain_timeline_entries;
DROP TABLE IF EXISTS goat.brain_edges;
DROP TABLE IF EXISTS goat.brain_import_candidates;
DROP TABLE IF EXISTS goat.brain_ingest_jobs;
DROP TABLE IF EXISTS goat.brain_source_event_claims;
DROP TABLE IF EXISTS goat.brain_source_items;
DROP TABLE IF EXISTS goat.brain_sources;
DROP TABLE IF EXISTS goat.brain_import_runs;
DROP TABLE IF EXISTS goat.brain_documents;
DROP TABLE IF EXISTS goat.brain_folders;
DROP TABLE IF EXISTS goat.brain_members;
DROP TABLE IF EXISTS goat.brains;
--> statement-breakpoint

ALTER TABLE goat.workspaces DROP COLUMN IF EXISTS legacy_brain_enabled;
