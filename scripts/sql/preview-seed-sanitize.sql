-- Preview-seed sanitization (issue #351).
--
-- Run this ONCE against the `preview-seed` Neon branch (NOT prod) after forking it from
-- production, so per-PR previews never contain prod PII, secrets, or customer source code.
-- Re-run after every re-fork/refresh of the seed.
--
--   psql "$SEED_DIRECT_URL" -f scripts/sql/preview-seed-sanitize.sql
--   # or: node scripts/preview-seed.mjs --apply-sanitize
--
-- Strategy (defense in depth, ordered children-before-parents, safe to re-run):
--   1. DELETE secret/credential/financial/transient rows outright.
--   2. Scrub every customer-authored or customer-identifying text/jsonb column in place
--      (keeps referential structure so previews boot).
--   3. A COVERAGE GUARD (final DO block) re-scans the live schema and RAISES — rolling the
--      whole transaction back — if any text/jsonb/array column carrying potential customer
--      content is NOT explicitly reviewed below. This is the safety net the prior hand-kept
--      denylist lacked: a new column added to the schema later can no longer leak silently,
--      because this script will *fail* (leaving the seed un-sanitized and obviously unusable)
--      until someone classifies the column here. Structural columns (ids, hashes, enums,
--      timestamps) are excluded by name pattern; genuine content columns must be allowlisted.

BEGIN;

-- =====================================================================================
-- 1) Hard deletes — secrets, credentials, billing PII, and transient job/queue rows.
--    Previews start with no connected integrations and mint their own sandbox creds.
-- =====================================================================================
DELETE FROM workspace_integration_credentials;
DELETE FROM workspace_mcp_credentials;
DELETE FROM stripe_checkout_sessions; -- workspace_credit_ledger.stripe_checkout_session_id is ON DELETE SET NULL
DELETE FROM user_avatars;
DELETE FROM workspace_sync_jobs; -- transient projection outbox; repo paths + last_error
DELETE FROM agent_session_run_jobs; -- transient run queue; lease owners + last_error

-- Legacy / backup tables that may still exist in an older seed fork: the deferred drops
-- from migration 0038 (brain/agent/agent_file sync jobs) and the migration 0024 resource
-- backup. They retain real prod file paths and resource names, so empty them if present.
-- Once the drop migrations land these become no-ops (guarded by to_regclass).
DO $legacy$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'brain_sync_jobs', 'agent_sync_jobs', 'agent_file_sync_jobs',
    'workspace_integration_resources_0024_backup'
  ] LOOP
    IF to_regclass('public.' || quote_ident(tbl)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %I', tbl);
    END IF;
  END LOOP;
END
$legacy$;

-- =====================================================================================
-- 2) Identity / PII — scrub email/name/avatar and break WorkOS linkage so seeded
--    identities can't be impersonated; real preview logins create fresh users/orgs.
-- =====================================================================================
UPDATE users
SET email = 'user-' || id || '@preview.invalid',
    first_name = 'Preview',
    last_name = 'User',
    avatar_url = NULL,
    workos_user_id = 'preview-' || id;

UPDATE workspaces
SET name = 'Preview Workspace',
    company_url = NULL,
    team_size = NULL,
    workos_organization_id = 'preview-' || id;

UPDATE onboarding_responses
SET heard_from = 'other',
    heard_from_detail = NULL,
    agent_experience = 'preview',
    help_areas = '{}';

-- =====================================================================================
-- 3) Integration / MCP / Slack / repo connection metadata (the secrets themselves were
--    deleted above). external_id columns carry NOT NULL unique indexes, so scrub them to
--    a per-row placeholder rather than NULL.
-- =====================================================================================
UPDATE workspace_integrations
SET connection_label = NULL,
    account_name = NULL,
    account_email = NULL,
    status_reason = NULL,
    external_id = 'preview-' || id,
    metadata = '{}'::jsonb;

UPDATE workspace_integration_resources
SET name = 'Preview Resource',
    display_name = NULL,
    status_reason = NULL,
    external_id = 'preview-' || id,
    metadata = '{}'::jsonb;

UPDATE workspace_mcp_servers
SET display_name = 'Preview MCP',
    endpoint_url = 'https://mcp.preview.invalid',
    status_reason = NULL,
    metadata = '{}'::jsonb;

UPDATE workspace_slack_channels
SET slack_channel_id = NULL,
    slack_team_id = NULL,
    invite_url = NULL,
    error = NULL;

UPDATE workspace_repositories
SET full_name = 'preview-org/preview-' || workspace_id,
    github_repo_id = '0',
    latest_head_sha = NULL;

UPDATE workspace_experiments
SET metadata = '{}'::jsonb;

-- =====================================================================================
-- 4) Customer-authored content — redact (keep rows so sessions/brain/files/agents still
--    resolve). File paths are scrubbed too: they can encode customer/project names, and
--    are rebuilt per-row to keep their (workspace, path) unique indexes intact.
-- =====================================================================================
UPDATE agents
SET name = 'Preview Agent',
    body = '',
    path = NULL,
    github_sync_error = NULL,
    content = '{"type":"doc","content":[]}'::jsonb,
    config = '{"schemaVersion":"agent.v1","title":"Preview agent","instructions":"","model":{"provider":"vercel-ai-gateway","name":"openai/gpt-5.4-mini"},"tools":[],"brain":[],"agents":[],"integrations":{"github":{"repositories":[]}},"triggers":[]}'::jsonb;

UPDATE brain_files
SET path = 'brain/preview-' || id || '.md',
    content = '',
    github_sync_error = NULL;

UPDATE agent_files
SET path = 'agents/preview-' || id || '.md',
    content = '',
    github_sync_error = NULL;

UPDATE workspace_skill_snapshots
SET name = 'Preview Skill',
    description = '',
    command = NULL,
    skill_path = '',
    source_url = 'https://example.invalid/skill/' || id,
    files = '[]'::jsonb;

UPDATE agent_sessions
SET title = 'Preview session',
    last_error = NULL,
    e2b_sandbox_id = NULL;

UPDATE agent_session_messages
SET content = '[redacted in preview seed]',
    model_message = NULL;

UPDATE agent_session_events
SET payload = '{}'::jsonb;

UPDATE agent_session_after_session_runs
SET last_error = NULL;

UPDATE agent_schedule_runs
SET error = NULL,
    reservation_token = NULL;

UPDATE agent_tool_approvals
SET input_preview = '[redacted in preview seed]';

UPDATE agent_session_questions
SET questions = '[]'::jsonb,
    answers = NULL;

UPDATE agent_session_artifacts
SET title = NULL,
    url = NULL,
    external_id = NULL,
    repository_full_name = NULL,
    branch_name = NULL,
    diff_stat = NULL,
    diff_preview = NULL,
    metadata = NULL;

UPDATE agent_session_brain_mounts
SET requested_path = 'brain/preview-' || id || '.md',
    path = 'brain/preview-' || id || '.md';

UPDATE agent_session_bundle_mounts
SET requested_path = 'bundle/preview-' || id,
    path = 'bundle/preview-' || id;

-- =====================================================================================
-- 5) Provider usage/telemetry blobs (raw provider payloads can echo prompt content).
-- =====================================================================================
UPDATE agent_session_usage SET raw_usage = '{}'::jsonb;
UPDATE agent_session_tool_usage SET raw_usage = '{}'::jsonb;
UPDATE agent_session_sandbox_usage SET raw_metrics = '{}'::jsonb, sandbox_id = 'preview';

-- =====================================================================================
-- 6) Billing — credit codes are bearer secrets; ledger metadata can hold notes.
-- =====================================================================================
UPDATE credit_codes SET code = 'PREVIEW-' || id;
UPDATE workspace_credit_ledger SET cost_basis = '{}'::jsonb, metadata = '{}'::jsonb;

-- =====================================================================================
-- 7) COVERAGE GUARD — fail (and roll back) if any unreviewed content column exists.
--    Scans every base table in `public`. A text/jsonb/array column passes only if it is
--    a structural column (excluded by name pattern) or appears in the reviewed allowlist
--    below. A new/renamed content column will not match either set, so the seed cannot be
--    declared safe until this file is updated to scrub it.
-- =====================================================================================
DO $guard$
DECLARE
  unhandled text;
BEGIN
  SELECT string_agg(format('%I.%I (%s)', c.table_name, c.column_name, c.data_type), ', '
                    ORDER BY c.table_name, c.column_name)
  INTO unhandled
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema
   AND t.table_name = c.table_name
   AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
    AND c.table_name NOT LIKE '\_\_%' ESCAPE '\'
    AND c.data_type IN ('text', 'jsonb', 'ARRAY')
    -- Structural columns that cannot carry free-form customer content.
    AND c.column_name <> 'id'
    AND c.column_name NOT LIKE '%\_id' ESCAPE '\'
    AND c.column_name NOT LIKE '%\_at' ESCAPE '\'
    AND c.column_name NOT LIKE '%\_sha' ESCAPE '\'
    AND c.column_name NOT LIKE '%hash%'
    AND c.column_name NOT IN (
      'status', 'role', 'source', 'kind', 'type', 'operation', 'provider', 'decision',
      'permission_group', 'reference_type', 'account_type', 'resource_type', 'source_kind',
      'source_type', 'model_provider', 'model_name', 'finish_reason', 'raw_finish_reason',
      'default_branch', 'server_key', 'provider_key', 'key', 'workdir', 'idempotency_key',
      'lease_id', 'lease_owner', 'run_lease_owner', 'reservation_token', 'trigger_id',
      'tool_name', 'mime', 'integrity', 'requested_ref', 'resolved_commit', 'template',
      'scopes', 'github_sync_status', 'status_reason', 'decision_source', 'resolution_source',
      'skipped_reason'
    )
    -- Reviewed content columns that are scrubbed or deleted above (allowlist).
    AND NOT EXISTS (
      SELECT 1 FROM ( VALUES
        ('users', 'email'), ('users', 'first_name'), ('users', 'last_name'),
        ('users', 'avatar_url'), ('users', 'workos_user_id'),
        ('workspaces', 'name'), ('workspaces', 'company_url'), ('workspaces', 'team_size'),
        ('workspaces', 'workos_organization_id'),
        ('onboarding_responses', 'heard_from'), ('onboarding_responses', 'heard_from_detail'),
        ('onboarding_responses', 'agent_experience'), ('onboarding_responses', 'help_areas'),
        ('agents', 'name'), ('agents', 'body'), ('agents', 'path'),
        ('agents', 'content'), ('agents', 'config'), ('agents', 'github_sync_error'),
        ('workspace_skill_snapshots', 'name'), ('workspace_skill_snapshots', 'description'),
        ('workspace_skill_snapshots', 'command'), ('workspace_skill_snapshots', 'source_url'),
        ('workspace_skill_snapshots', 'skill_path'), ('workspace_skill_snapshots', 'files'),
        ('brain_files', 'path'), ('brain_files', 'content'), ('brain_files', 'github_sync_error'),
        ('agent_files', 'path'), ('agent_files', 'content'), ('agent_files', 'github_sync_error'),
        ('agent_sessions', 'title'), ('agent_sessions', 'last_error'),
        ('agent_session_messages', 'content'), ('agent_session_messages', 'model_message'),
        ('agent_session_events', 'payload'),
        ('agent_session_after_session_runs', 'last_error'),
        ('agent_schedule_runs', 'error'),
        ('agent_tool_approvals', 'input_preview'),
        ('agent_session_questions', 'questions'), ('agent_session_questions', 'answers'),
        ('agent_session_artifacts', 'title'), ('agent_session_artifacts', 'url'),
        ('agent_session_artifacts', 'repository_full_name'),
        ('agent_session_artifacts', 'branch_name'), ('agent_session_artifacts', 'diff_stat'),
        ('agent_session_artifacts', 'diff_preview'), ('agent_session_artifacts', 'metadata'),
        ('agent_session_brain_mounts', 'requested_path'), ('agent_session_brain_mounts', 'path'),
        ('agent_session_bundle_mounts', 'requested_path'), ('agent_session_bundle_mounts', 'path'),
        ('agent_session_usage', 'raw_usage'),
        ('agent_session_tool_usage', 'raw_usage'),
        ('agent_session_sandbox_usage', 'raw_metrics'),
        ('workspace_integrations', 'connection_label'), ('workspace_integrations', 'account_name'),
        ('workspace_integrations', 'account_email'), ('workspace_integrations', 'metadata'),
        ('workspace_integration_resources', 'name'),
        ('workspace_integration_resources', 'display_name'),
        ('workspace_integration_resources', 'metadata'),
        ('workspace_mcp_servers', 'display_name'), ('workspace_mcp_servers', 'endpoint_url'),
        ('workspace_mcp_servers', 'metadata'),
        ('workspace_slack_channels', 'invite_url'), ('workspace_slack_channels', 'error'),
        ('workspace_repositories', 'full_name'),
        ('workspace_experiments', 'metadata'),
        ('workspace_credit_ledger', 'cost_basis'), ('workspace_credit_ledger', 'metadata'),
        ('credit_codes', 'code'),
        -- Tables whose rows are fully deleted in section 1 (columns retained, rows empty).
        ('workspace_integration_credentials', 'encrypted_payload'),
        ('workspace_mcp_credentials', 'encrypted_payload'),
        ('stripe_checkout_sessions', 'metadata'),
        ('user_avatars', 'mime'),
        ('workspace_sync_jobs', 'repo_path'), ('workspace_sync_jobs', 'source_ref'),
        ('workspace_sync_jobs', 'previous_path'), ('workspace_sync_jobs', 'last_error'),
        ('agent_session_run_jobs', 'last_error'),
        -- Legacy/backup tables emptied above (present only until their drop migrations land).
        ('brain_sync_jobs', 'path'), ('brain_sync_jobs', 'previous_path'),
        ('brain_sync_jobs', 'last_error'),
        ('agent_sync_jobs', 'path'), ('agent_sync_jobs', 'previous_path'),
        ('agent_sync_jobs', 'last_error'),
        ('agent_file_sync_jobs', 'path'), ('agent_file_sync_jobs', 'previous_path'),
        ('agent_file_sync_jobs', 'last_error'),
        ('workspace_integration_resources_0024_backup', 'name'),
        ('workspace_integration_resources_0024_backup', 'display_name'),
        ('workspace_integration_resources_0024_backup', 'metadata'),
        ('workspace_integration_resources_0024_backup', 'backup_reason')
      ) AS known(t, col)
      WHERE known.t = c.table_name AND known.col = c.column_name
    );

  IF unhandled IS NOT NULL THEN
    RAISE EXCEPTION
      'preview-seed-sanitize: unreviewed text/jsonb/array column(s) detected — classify them in scripts/sql/preview-seed-sanitize.sql before trusting the seed: %',
      unhandled;
  END IF;
END
$guard$;

COMMIT;
